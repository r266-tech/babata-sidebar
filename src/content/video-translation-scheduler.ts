import { shouldTranslateText } from "../translation-language";
import { CaptionTimeline, captionTextKey } from "./video-captions";
import type { CaptionCue } from "./youtube-captions";

export interface SubtitleTranslationResult {
  ok: boolean;
  results?: Array<{ hash: string; translated: string }>;
  error?: string;
  retryable?: boolean;
  retry_after_ms?: number;
  errors?: Array<{ hash: string; retryable?: boolean; retry_after_ms?: number }>;
}

type Translate = (batch: Array<{ hash: string; text: string }>, signal: AbortSignal) => Promise<SubtitleTranslationResult>;

/** Independent from playback rendering. Every completed batch is published
 * immediately; a slow speculative batch cannot hold an already-ready cue. */
export class SubtitleTranslationScheduler {
  timeline = new CaptionTimeline([]);
  language = "";
  enabled = true;
  private sourceId = "";
  private generation = 0;
  private controllers = new Set<AbortController>();
  private pending = new Map<string, AbortController>();
  private translations = new Map<string, string>();
  private failures = new Map<string, { count: number; after: number }>();
  private queue: CaptionCue[] = [];
  private latestTime = 0;
  private rate = 1;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private translate: Translate, private onUpdate: (error?: string) => void, readonly target = "zh") {}

  setSource(id: string, cues: CaptionCue[], language = ""): void {
    // Track changes invalidate ownership. Appending live cues keeps existing
    // requests and finished cache entries, avoiding a restart every cuechange.
    if (id !== this.sourceId || language !== this.language) this.cancel();
    this.sourceId = id;
    this.language = language;
    this.timeline = new CaptionTimeline(cues);
  }

  translated(cue: CaptionCue): string | undefined {
    if (!shouldTranslateText(cue.text, this.target, this.language)) return cue.text;
    return this.translations.get(this.key(cue));
  }

  key(cue: CaptionCue): string { return captionTextKey(cue.text, this.target, this.language); }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
    else this.update(this.latestTime, this.rate);
  }

  seek(timeMs: number, rate = 1): void {
    this.cancel();
    this.update(timeMs, rate);
  }

  cancel(): void {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.pending.clear();
    this.queue = [];
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  invalidate(): void {
    this.cancel();
    this.translations.clear();
    this.failures.clear();
    this.update(this.latestTime, this.rate);
  }

  update(timeMs: number, rate = 1): void {
    this.latestTime = timeMs;
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    if (!this.enabled) return;
    const active = this.timeline.indexAt(timeMs);
    const center = active >= 0 ? active : this.timeline.nextIndex(timeMs);
    if (center < 0) { this.queue = []; return; }
    const now = Date.now();
    const seen = new Set<string>();
    this.queue = [];
    let nextRetry = Infinity;
    for (let at = center; at < this.timeline.cues.length && at < center + 36; at += 1) {
      const cue = this.timeline.cues[at];
      if (cue.startMs > timeMs + 35_000 * this.rate) break;
      const key = this.key(cue);
      if (seen.has(key) || this.translated(cue) !== undefined || this.pending.has(key)) continue;
      seen.add(key);
      const failure = this.failures.get(key);
      if (failure && failure.count >= 3) continue;
      if (failure && failure.after > now) { nextRetry = Math.min(nextRetry, failure.after); continue; }
      this.queue.push(cue);
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = Number.isFinite(nextRetry)
      ? setTimeout(() => this.update(this.latestTime, this.rate), Math.max(20, nextRetry - now))
      : undefined;
    this.pump();
  }

  private pump(): void {
    while (this.enabled && this.controllers.size < 2 && this.queue.length) {
      const current = this.timeline.cues[this.timeline.indexAt(this.latestTime)];
      const urgent = current && this.key(this.queue[0]) === this.key(current);
      const batch: CaptionCue[] = [];
      let characters = 0;
      const limit = urgent ? 3 : 8;
      while (this.queue.length && batch.length < limit) {
        const cue = this.queue[0];
        if (batch.length && characters + cue.text.length > 6000) break;
        this.queue.shift();
        const key = this.key(cue);
        if (this.pending.has(key) || this.translated(cue) !== undefined) continue;
        batch.push(cue);
        characters += cue.text.length;
      }
      if (!batch.length) break;
      const controller = new AbortController();
      this.controllers.add(controller);
      for (const cue of batch) this.pending.set(this.key(cue), controller);
      void this.execute(batch, controller, this.generation);
    }
  }

  private async execute(cues: CaptionCue[], controller: AbortController, generation: number): Promise<void> {
    const batch = cues.map((cue) => ({ hash: this.key(cue), text: cue.text }));
    try {
      const response = await this.translate(batch, controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return;
      const expected = new Set(batch.map((item) => item.hash));
      const completed = new Set<string>();
      for (const item of response.results ?? []) {
        if (!expected.has(item.hash) || completed.has(item.hash) || typeof item.translated !== "string" || !item.translated.trim()) continue;
        completed.add(item.hash);
        this.translations.delete(item.hash);
        this.translations.set(item.hash, item.translated.trim());
        this.failures.delete(item.hash);
      }
      while (this.translations.size > 2500) this.translations.delete(this.translations.keys().next().value!);
      const errors = new Map((response.errors ?? []).map((error) => [error.hash, error]));
      for (const item of batch) {
        const error = errors.get(item.hash);
        if (!completed.has(item.hash)) this.failed(item.hash, (error?.retryable ?? response.retryable) !== false, error?.retry_after_ms ?? response.retry_after_ms);
      }
      this.onUpdate(response.ok ? undefined : response.error || "字幕翻译暂不可用，已保留原文");
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      for (const item of batch) this.failed(item.hash, true);
      this.onUpdate(error instanceof Error ? error.message : "字幕翻译暂不可用，已保留原文");
    } finally {
      this.controllers.delete(controller);
      for (const item of batch) if (this.pending.get(item.hash) === controller) this.pending.delete(item.hash);
      if (generation === this.generation && !controller.signal.aborted) this.update(this.latestTime, this.rate);
    }
  }

  private failed(key: string, retryable: boolean, retryAfter = 0): void {
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    this.failures.set(key, {
      count: retryable ? count : 3,
      after: Date.now() + Math.max(Math.min(retryAfter, 60_000), 1200 * 2 ** (count - 1)),
    });
  }
}
