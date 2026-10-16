const PRIORITIES = { interactive: 0, subtitle: 1, visible: 2, prefetch: 3 };

export function priorityRank(priority) {
  return PRIORITIES[priority] ?? PRIORITIES.visible;
}

export function translationError(message, status = 502, code = "provider_error", retryable = false, retryAfterMs) {
  const error = new Error(message);
  Object.assign(error, { status, code, retryable });
  if (Number.isFinite(retryAfterMs)) error.retry_after_ms = Math.max(0, Math.ceil(retryAfterMs));
  return error;
}

export function abortReason(signal) {
  return signal?.reason ?? new DOMException("Translation cancelled", "AbortError");
}

// Only numeric aggregates and a bounded duration sample are retained. No text,
// URLs, provider names, request IDs or credentials enter these metrics.
export function durationSummary(samples) {
  if (!samples.length) return { samples: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50_ms: Math.round(sorted[Math.floor((sorted.length - 1) * 0.5)]),
    p95_ms: Math.round(sorted[Math.ceil((sorted.length - 1) * 0.95)]),
    max_ms: Math.round(sorted.at(-1)),
  };
}

export function recordDuration(samples, ms) {
  samples.push(Math.max(0, ms));
  if (samples.length > 256) samples.shift();
}

export function createProviderScheduler({ concurrency = 8, maxQueued = 128, queueTimeoutMs = 30_000, agingMs = 5_000, requestsPerSecond = 4, burst = 8 } = {}) {
  const queue = [];
  const buckets = new Map();
  const queueDurations = [];
  const runDurations = [];
  const counters = { submitted: 0, started: 0, completed: 0, failed: 0, cancelled: 0, rejected: 0, queue_timeouts: 0, cooldowns: 0, peak_active: 0, peak_queued: 0 };
  let active = 0;
  let sequence = 0;
  let wakeTimer;

  function bucketFor(key, now) {
    let state = buckets.get(key);
    if (!state) {
      // Identity keys are opaque digests. Evict only idle buckets, so config
      // churn cannot reset throttling for work already waiting or running.
      if (buckets.size >= 512) {
        const queuedKeys = new Set(queue.map((entry) => entry.bucket));
        for (const [oldKey, old] of buckets) {
          if (!old.active && old.cooldownUntil <= now && !queuedKeys.has(oldKey)) buckets.delete(oldKey);
          if (buckets.size < 512) break;
        }
        if (buckets.size >= 512) throw translationError("Too many active provider identities", 503, "provider_identity_limit", true, 1000);
      }
      state = { tokens: burst, updatedAt: now, cooldownUntil: 0, active: 0 };
      buckets.set(key, state);
    }
    state.tokens = Math.min(burst, state.tokens + (now - state.updatedAt) * requestsPerSecond / 1000);
    state.updatedAt = now;
    return state;
  }

  function readyIn(state, now) {
    const rateWait = state.tokens >= 1 ? 0 : (1 - state.tokens) * 1000 / requestsPerSecond;
    return Math.max(rateWait, state.cooldownUntil - now, 0);
  }

  function drain() {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
    while (active < concurrency && queue.length) {
      const now = performance.now();
      // Age background work into the highest class so sustained visible work
      // cannot starve it. New high-priority subscribers can promote queued work.
      const rank = (entry) => Math.max(0, priorityRank(typeof entry.priority === "function" ? entry.priority() : entry.priority)
        - Math.floor((now - entry.enqueuedAt) / agingMs));
      queue.sort((a, b) => rank(a) - rank(b) || a.sequence - b.sequence);
      let selected = -1;
      let nextReadyIn = Infinity;
      for (let index = 0; index < queue.length; index += 1) {
        // A translation can briefly keep its shared work attachable after its
        // final subscriber leaves. Never start an unused queued call or retry
        // during that grace window; its owner will rejoin or abort it shortly.
        if (queue[index].isNeeded?.() === false) continue;
        const wait = readyIn(bucketFor(queue[index].bucket, now), now);
        if (wait <= 0) { selected = index; break; }
        nextReadyIn = Math.min(nextReadyIn, wait);
      }
      if (selected === -1) {
        // Waiting for this provider must not occupy a global worker. Another
        // provider can still start immediately when it joins the queue.
        // Dormant entries wake only when their subscribers change or their
        // cancellation/queue timeout fires. They need no polling timer.
        if (Number.isFinite(nextReadyIn)) wakeTimer = setTimeout(drain, Math.max(1, Math.ceil(nextReadyIn)));
        return;
      }
      const [entry] = queue.splice(selected, 1);
      entry.queued = false;
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.unsubscribeDemand?.();
      if (entry.signal?.aborted) { entry.reject(abortReason(entry.signal)); continue; }
      const bucket = bucketFor(entry.bucket, now);
      bucket.tokens -= 1;
      bucket.active += 1;
      active += 1;
      counters.started += 1;
      counters.peak_active = Math.max(counters.peak_active, active);
      recordDuration(queueDurations, performance.now() - entry.enqueuedAt);
      const started = performance.now();
      // Start in the same turn as the demand check. Deferring the call itself
      // lets a cancellation microtask remove the last subscriber in between,
      // starting a provider request that nobody needs despite the queue gate.
      let running;
      try { running = entry.run(); }
      catch (error) { running = Promise.reject(error); }
      Promise.resolve(running).then((result) => {
        counters.completed += 1;
        entry.resolve(result);
      }, (error) => {
        if (entry.signal?.aborted) counters.cancelled += 1;
        else counters.failed += 1;
        entry.reject(error);
      }).finally(() => {
        active -= 1;
        bucket.active -= 1;
        recordDuration(runDurations, performance.now() - started);
        drain();
      });
    }
  }

  return {
    run(run, { signal, priority = "visible", bucket = "default", isNeeded, onDemandChange } = {}) {
      signal?.throwIfAborted();
      counters.submitted += 1;
      let state;
      const now = performance.now();
      try { state = bucketFor(bucket, now); }
      catch (error) { counters.rejected += 1; return Promise.reject(error); }
      if (queue.length >= maxQueued && (active >= concurrency || readyIn(state, now) > 0 || isNeeded?.() === false)) {
        counters.rejected += 1;
        return Promise.reject(translationError("Translation queue is full", 429, "queue_full", true, 1000));
      }
      return new Promise((resolve, reject) => {
        const entry = { run, signal, priority, bucket, isNeeded, resolve, reject, sequence: sequence++, enqueuedAt: performance.now(), queued: true };
        const remove = () => {
          if (!entry.queued) return false;
          entry.queued = false;
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          clearTimeout(entry.timer);
          signal?.removeEventListener("abort", entry.onAbort);
          entry.unsubscribeDemand?.();
          return true;
        };
        entry.onAbort = () => {
          if (!remove()) return;
          counters.cancelled += 1;
          reject(abortReason(signal));
          drain();
        };
        entry.timer = setTimeout(() => {
          if (!remove()) return;
          counters.queue_timeouts += 1;
          const state = buckets.get(bucket);
          const retryAfter = Math.max(1000, state ? readyIn(bucketFor(bucket, performance.now()), performance.now()) : 0);
          reject(translationError("Translation queue wait timed out", 503, "queue_timeout", true, retryAfter));
          drain();
        }, queueTimeoutMs);
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        entry.unsubscribeDemand = onDemandChange?.(drain);
        queue.push(entry);
        counters.peak_queued = Math.max(counters.peak_queued, queue.length);
        drain();
      });
    },
    cooldown(bucket, durationMs) {
      const now = performance.now();
      const state = bucketFor(bucket, now);
      state.cooldownUntil = Math.max(state.cooldownUntil, now + Math.max(0, durationMs));
      counters.cooldowns += 1;
      drain();
    },
    stats() {
      const now = performance.now();
      return { ...counters, active, queued: queue.length, concurrency, max_queued: maxQueued, requests_per_second: requestsPerSecond, burst, cooling_buckets: [...buckets.values()].filter((state) => state.cooldownUntil > now).length, queue_wait: durationSummary(queueDurations), provider_time: durationSummary(runDurations) };
    },
  };
}
