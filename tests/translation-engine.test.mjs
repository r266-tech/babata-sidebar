import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createTranslationEngine, markersPreserved, validateTranslationResponse } from '../companion/translation-engine.mjs';
import { createProviderScheduler } from '../companion/translation-scheduler.mjs';
import { startCompanion, extensionOrigin } from './companion-fixture.mjs';

const provider = { base_url: 'https://provider.test/v1', model: 'test-model', api_key: 'private-test-key' };
const responseFor = (batch) => ({ content: JSON.stringify({ results: batch.map((item) => ({ hash: item.hash, translated: `译文 ${item.text}` })) }), finishReason: 'stop' });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const input = (text = 'Hello world.', hash = 'a', extra = {}) => ({ target: 'zh', batch: [{ hash, text }], ...extra });
async function until(check) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (check()) return; await delay(5); }
  assert.fail('condition did not become true');
}

await test('marker validation preserves tokens, nesting, protected placeholders and item coverage', () => {
  const source = '[[BBT_LINK_1]][[BBT_FMT_2]]Hello[[/BBT_FMT_2]][[/BBT_LINK_1]] [[BBT_KEEP_3]]';
  assert.equal(markersPreserved(source, source.replace('Hello', '你好')), true);
  for (const bad of [source.replace('[[BBT_KEEP_3]]', ''), source + '[[BBT_KEEP_4]]', source.replace('[[BBT_KEEP_3]]', '[[BBT_KEEP_9]]'), source.replace('[[/BBT_FMT_2]][[/BBT_LINK_1]]', '[[/BBT_LINK_1]][[/BBT_FMT_2]]'), source + '[[/BBT_KEEP_3]]', source + '[[BBT_FMT_invalid]]']) {
    assert.equal(markersPreserved(source, bad), false);
  }
  const batch = [{ hash: 'a', text: 'Hello' }, { hash: 'b', text: source }, { hash: 'c', text: 'Goodbye' }];
  const partial = validateTranslationResponse(JSON.stringify({ results: [{ hash: 'a', translated: '你好' }, { hash: 'b', translated: source }, { hash: 'b', translated: source }] }), batch, 'stop');
  assert.equal(partial.get('a').translated, '你好');
  assert.equal(partial.get('b').error.code, 'duplicate_result');
  assert.equal(partial.get('c').error.code, 'missing_result');
  assert.equal(partial.get('c').error.retryable, true);
  for (const [content, reason, code] of [['', 'stop', 'empty_output'], ['{}', 'stop', 'invalid_schema'], ['not JSON', 'stop', 'invalid_json'], ['{"results":[]}', 'length', 'incomplete_output'], ['{"results":[{"hash":"foreign","translated":"x"}]}', 'stop', 'unexpected_hash']]) {
    assert.equal(validateTranslationResponse(content, batch, reason).get('a').error.code, code);
  }
});

await test('semantic single-flight merges overlapping requests and never trusts client hashes', async () => {
  const gate = deferred();
  const calls = [];
  const engine = createTranslationEngine({ complete: async ({ batch }) => { calls.push(batch); await gate.promise; return responseFor(batch); } });
  const a = engine.translate(provider, { target: 'zh', batch: [{ hash: 'a', text: 'Same source' }, { hash: 'b', text: 'Second source' }] });
  await until(() => calls.length === 1);
  const b = engine.translate(provider, input('Same source', 'different-client-hash'));
  gate.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.deepEqual(ra.results.map((item) => item.hash), ['a', 'b']);
  assert.equal(rb.results[0].hash, 'different-client-hash');
  assert.equal(rb.results[0].translated, '译文 Same source');
  await engine.translate(provider, input('Same source', 'another-hash'));
  assert.equal(calls.length, 1, 'completed semantic item is reused across client routing hashes');
  await engine.translate(provider, input('Different source', 'a'));
  assert.equal(calls.length, 2, 'reusing a caller hash must not reuse an unrelated translation');
  assert.equal(engine.stats().coalesced_items, 1);
  assert.equal(engine.stats().cache_hits, 1);
});

await test('cancelling one subscriber preserves shared work; the last subscriber aborts it', async () => {
  const gate = deferred();
  let upstreamSignal;
  const engine = createTranslationEngine({ complete: async ({ batch, signal }) => {
    upstreamSignal = signal;
    await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    return responseFor(batch);
  } });
  const first = new AbortController();
  const second = new AbortController();
  const a = engine.translate(provider, input(), first.signal);
  const cancelledA = assert.rejects(a, { name: 'AbortError' });
  await until(() => upstreamSignal);
  const b = engine.translate(provider, input('Hello world.', 'b'), second.signal);
  first.abort();
  await cancelledA;
  assert.equal(upstreamSignal.aborted, false);
  gate.resolve();
  assert.equal((await b).complete, true);
  assert.equal(engine.stats().pending_items, 0);

  const last = new AbortController();
  let lastSignal;
  const waiting = createTranslationEngine({ complete: ({ signal }) => {
    lastSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const work = waiting.translate(provider, input(), last.signal);
  const cancelled = assert.rejects(work, { name: 'AbortError' });
  await until(() => lastSignal);
  last.abort();
  await cancelled;
  assert.equal(lastSignal.aborted, true);
  assert.equal(waiting.stats().pending_items, 0);
});

await test('an orphaned item can rejoin a still-needed shared provider batch', async () => {
  const gate = deferred();
  let calls = 0;
  const engine = createTranslationEngine({ complete: async ({ batch }) => { calls++; await gate.promise; return responseFor(batch); } });
  const controller = new AbortController();
  const full = engine.translate(provider, { batch: [{ hash: 'a', text: 'Alpha' }, { hash: 'b', text: 'Beta' }] }, controller.signal);
  const cancelled = assert.rejects(full, { name: 'AbortError' });
  const alpha = engine.translate(provider, input('Alpha'));
  await until(() => calls === 1);
  controller.abort();
  await cancelled;
  const beta = engine.translate(provider, input('Beta'));
  gate.resolve();
  assert.equal((await alpha).complete, true);
  assert.equal((await beta).complete, true);
  assert.equal(calls, 1);
});

await test('cache identity isolates provider, key, model, language and exact source; force bypasses it', async () => {
  let calls = 0;
  const engine = createTranslationEngine({ complete: async ({ batch }) => { calls++; return responseFor(batch); } });
  await engine.translate(provider, input());
  await engine.translate({ ...provider, base_url: 'https://provider.test/v1/chat/completions' }, input());
  assert.equal(calls, 1, 'equivalent endpoint spelling shares identity');
  for (const override of [{ model: 'other' }, { api_key: 'other-key' }, { base_url: 'https://different.test/v1' }]) await engine.translate({ ...provider, ...override }, input());
  await engine.translate(provider, input('Hello world.', 'a', { target: 'ja' }));
  await engine.translate(provider, input('Hello  world.'));
  assert.equal(calls, 6);
  await engine.translate(provider, input(), undefined, { force: true });
  assert.equal(calls, 7);
  assert.doesNotMatch(JSON.stringify(engine.stats()), /private-test-key|Hello|provider\.test/);
});

await test('cache honors LRU entry bounds, byte bounds, TTL and an explicit disable', async () => {
  let calls = 0;
  const complete = async ({ batch }) => { calls++; return responseFor(batch); };
  const engine = createTranslationEngine({ complete, cacheMaxEntries: 2, cacheTtlMs: 40 });
  await engine.translate(provider, input('one'));
  await engine.translate(provider, input('two'));
  await engine.translate(provider, input('one'));
  await engine.translate(provider, input('three'));
  await engine.translate(provider, input('two'));
  assert.equal(calls, 4, 'two was the least recently used entry');
  assert.equal(engine.stats().cache_entries, 2);
  await delay(55);
  assert.equal(engine.stats().cache_entries, 0);
  await engine.translate(provider, input('two'));
  assert.equal(calls, 5);
  const small = createTranslationEngine({ complete, cacheMaxBytes: 10 });
  await small.translate(provider, input());
  assert.equal(small.stats().cache_entries, 0);
  const disabled = createTranslationEngine({ complete, cacheMaxEntries: 0 });
  await disabled.translate(provider, input());
  assert.equal(disabled.stats().cache_entries, 0);
});

await test('invalid and partial outputs never poison cache; valid partial items are reusable', async () => {
  let calls = 0;
  const engine = createTranslationEngine({ complete: async ({ batch }) => {
    calls++;
    return { content: JSON.stringify({ results: [{ hash: batch[0].hash, translated: '正常译文' }] }), finishReason: 'stop' };
  } });
  const result = await engine.translate(provider, { batch: [{ hash: 'a', text: 'Alpha' }, { hash: 'b', text: 'Beta' }] });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.results, [{ hash: 'a', translated: '正常译文' }]);
  assert.equal(result.errors[0].hash, 'b');
  assert.equal(result.errors[0].code, 'missing_result');
  await engine.translate(provider, input('Alpha'));
  assert.equal(calls, 1);
  await engine.translate(provider, input('Beta'));
  assert.equal(calls, 2);
});

await test('server item/batch budgets reject explicitly before any provider dispatch', async () => {
  let called = false;
  const engine = createTranslationEngine({ complete: async () => { called = true; }, maxBatchItems: 2, maxItemChars: 8, maxBatchChars: 12 });
  for (const [payload, code] of [
    [{ batch: Array.from({ length: 3 }, (_, i) => ({ hash: String(i), text: 'a' })) }, 'batch_too_large'],
    [input('123456789'), 'item_too_large'],
    [{ batch: [{ hash: 'a', text: '1234567' }, { hash: 'b', text: '1234567' }] }, 'batch_too_large'],
    [{ batch: [{ hash: 'a', text: 'one' }, { hash: 'a', text: 'two' }] }, 'duplicate_hash'],
    [{ batch: [{ hash: 'a', text: '' }] }, 'invalid_item'],
    [input('hi', 'a', { priority: 'forged' }), 'invalid_priority'],
  ]) await assert.rejects(engine.translate(provider, payload), { code });
  assert.equal(called, false);
});

await test('provider scheduler prioritizes interactive work, bounds waiting, and removes cancelled jobs', async () => {
  const scheduler = createProviderScheduler({ concurrency: 1, maxQueued: 2, queueTimeoutMs: 2000 });
  const gate = deferred();
  const order = [];
  const active = scheduler.run(async () => { order.push('active'); await gate.promise; });
  const low = scheduler.run(async () => { order.push('prefetch'); }, { priority: 'prefetch' });
  const high = scheduler.run(async () => { order.push('interactive'); }, { priority: 'interactive' });
  await assert.rejects(scheduler.run(async () => {}), { code: 'queue_full', status: 429, retryable: true });
  gate.resolve();
  await Promise.all([active, low, high]);
  assert.deepEqual(order, ['active', 'interactive', 'prefetch']);
  assert.equal(scheduler.stats().peak_active, 1);

  const held = deferred();
  const blocker = scheduler.run(() => held.promise);
  const controller = new AbortController();
  let dispatched = false;
  const cancelled = scheduler.run(() => { dispatched = true; }, { signal: controller.signal });
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejection;
  held.resolve();
  await blocker;
  assert.equal(dispatched, false);
  assert.equal(scheduler.stats().queued, 0);
});

await test('queued work times out without dispatch, and item backpressure is bounded', async () => {
  const scheduler = createProviderScheduler({ concurrency: 1, maxQueued: 1, queueTimeoutMs: 15 });
  const gate = deferred();
  const active = scheduler.run(() => gate.promise);
  await assert.rejects(scheduler.run(() => assert.fail('expired job was dispatched')), { code: 'queue_timeout', status: 503, retryable: true });
  gate.resolve();
  await active;
  assert.equal(scheduler.stats().queue_timeouts, 1);

  const completeGate = deferred();
  const engine = createTranslationEngine({ maxPendingItems: 1, complete: async ({ batch }) => { await completeGate.promise; return responseFor(batch); } });
  const first = engine.translate(provider, input('first'));
  await assert.rejects(engine.translate(provider, input('second')), { code: 'queue_full', retryable: true });
  assert.equal(engine.stats().pending_items, 1);
  completeGate.resolve();
  await first;
});

await test('shared provider cooldown leaves slots free for other identities and retains priority', async () => {
  const scheduler = createProviderScheduler({ concurrency: 2, maxQueued: 2, requestsPerSecond: 100, burst: 2 });
  const order = [];
  scheduler.cooldown('cooling-provider', 65);
  const background = scheduler.run(() => { order.push('background'); }, { bucket: 'cooling-provider', priority: 'prefetch' });
  const foreground = scheduler.run(() => { order.push('foreground'); }, { bucket: 'cooling-provider', priority: 'interactive' });
  assert.equal(scheduler.stats().active, 0, 'cooldown does not occupy a worker');
  await assert.rejects(scheduler.run(() => assert.fail('queue overflow'), { bucket: 'cooling-provider' }), { code: 'queue_full' });
  await scheduler.run(() => { order.push('other-provider'); }, { bucket: 'independent-provider' });
  assert.deepEqual(order, ['other-provider']);
  await Promise.all([background, foreground]);
  assert.deepEqual(order, ['other-provider', 'foreground', 'background']);
});

await test('token bucket paces requests independently from concurrent worker limits', async () => {
  const scheduler = createProviderScheduler({ concurrency: 4, requestsPerSecond: 20, burst: 1 });
  const started = performance.now();
  const arrivals = [];
  await Promise.all([0, 1, 2].map(() => scheduler.run(() => { arrivals.push(performance.now() - started); }, { bucket: 'paced-provider' })));
  assert.equal(arrivals.length, 3);
  assert.ok(arrivals[1] >= 35, 'second request waits for refill even though workers are free');
  assert.ok(arrivals[2] >= 85, 'sustained request rate obeys the token bucket');
  assert.equal(scheduler.stats().peak_active, 1);
});

await test('HTTP provider test, partial errors, caching, retry metadata and stats use the real server path', async (t) => {
  let mode = 'valid';
  let hits = 0;
  let lastInput;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    lastInput = JSON.parse(request.messages.at(-1).content);
    hits++;
    res.setHeader('content-type', 'application/json');
    if (mode === 'rate-long') { res.writeHead(429, { 'retry-after': '20' }); res.end('{"error":{"message":"mock busy"}}'); return; }
    if (mode === 'rate-once' && hits === 1) { res.writeHead(429, { 'retry-after': '0.01' }); res.end('{"error":{"message":"mock busy"}}'); return; }
    const content = mode === 'empty' ? '' : mode === 'echo'
      ? JSON.stringify({ results: lastInput.batch.map((item) => ({ hash: item.hash, translated: item.text })) })
      : JSON.stringify({ results: lastInput.batch.slice(0, mode === 'partial' ? 1 : undefined).map((item) => ({ hash: item.hash, translated: `你好 ${item.text}` })) });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const server = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '2000', BABATA_PROVIDER_RETRY_BASE_MS: '5', BABATA_PROVIDER_RETRY_MAX_WAIT_MS: '100', BABATA_PROVIDER_MAX_RETRIES: '1' });
  t.after(async () => { await server.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const config = { base_url: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'mock', api_key: '' };

  mode = 'empty';
  let response = await server.post('/translate/test', config);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'empty_output');
  mode = 'echo';
  response = await server.post('/translate/test', config);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'test_not_translated');
  mode = 'valid';
  response = await server.post('/translate/test', config);
  const check = await response.json();
  assert.equal(response.status, 200);
  assert.equal(check.checked_items, 3);
  assert.equal(check.marker_protocol, 'LINK/FMT/KEEP');
  assert.ok(lastInput.batch.some((item) => item.text.includes('[[BBT_KEEP_1]]')));
  const before = hits;
  await (await server.post('/translate/test', config)).json();
  assert.equal(hits, before + 1, 'capability checks always probe the actual provider');

  mode = 'partial';
  response = await server.post('/translate', { ...config, batch: [{ hash: 'a', text: 'Unique alpha' }, { hash: 'b', text: 'Unique beta' }], request_id: 'r1' });
  const partial = await response.json();
  assert.equal(partial.partial, true);
  assert.equal(partial.request_id, 'r1');
  assert.equal(partial.results[0].hash, 'a');
  assert.equal(partial.errors[0].hash, 'b');
  const afterPartial = hits;
  await (await server.post('/translate', { ...config, ...input('Unique alpha', 'cached-a') })).json();
  assert.equal(hits, afterPartial);

  mode = 'rate-once'; hits = 0;
  response = await server.post('/translate', { ...config, ...input('Retry this once') });
  assert.equal((await response.json()).complete, true);
  assert.equal(hits, 2);
  mode = 'rate-long';
  response = await server.post('/translate', { ...config, ...input('Wait for this later') });
  const limited = await response.json();
  assert.equal(limited.errors[0].code, 'provider_rate_limited');
  assert.equal(limited.errors[0].retryable, true);
  assert.equal(limited.errors[0].retry_after_ms, 20000);
  response = await server.post('/translate/test', { ...config, api_key: 'separate-test-identity' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '20');
  await response.json();

  response = await server.post('/translate', { ...config, batch: Array.from({ length: 49 }, (_, i) => ({ hash: String(i), text: 'too many' })) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'batch_too_large');
  const stats = await (await server.request('/translate/stats')).json();
  assert.equal(stats.ok, true);
  assert.ok(stats.translation.cache_hits >= 1);
  assert.ok(stats.provider.retries >= 1);
  assert.ok(stats.provider.prompt_tokens >= 10);
  assert.doesNotMatch(JSON.stringify(stats), /Unique alpha|private-test-key|127\.0\.0\.1|mock busy|r1/);
});

await test('HTTP 429 cooldown is shared by new requests while another provider identity proceeds', async (t) => {
  let limitedHits = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const batch = JSON.parse(request.messages.at(-1).content).batch;
    res.setHeader('content-type', 'application/json');
    if (request.model === 'limited-model' && ++limitedHits === 1) {
      res.writeHead(429, { 'retry-after': '0.18' }); res.end('{"error":"limited"}'); return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: responseFor(batch).content } }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const server = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '2000', BABATA_PROVIDER_MAX_RETRIES: '0', BABATA_PROVIDER_RETRY_BASE_MS: '5', BABATA_PROVIDER_MAX_CONCURRENT: '2' });
  t.after(async () => { await server.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const config = { base_url: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'limited-model', api_key: '' };
  const first = await (await server.post('/translate', { ...config, ...input('First limited request') })).json();
  assert.equal(first.errors[0].retry_after_ms, 180);
  const waiting = server.post('/translate', { ...config, ...input('Second limited request') }).then((response) => response.json());
  const independent = await (await server.post('/translate', { ...config, model: 'independent-model', ...input('Other provider work') })).json();
  assert.equal(independent.complete, true);
  assert.equal(limitedHits, 1, 'new requests share the existing cooldown instead of hammering upstream');
  assert.equal((await waiting).complete, true);
  assert.equal(limitedHits, 2);
});

await test('transcription settings preserve explicit clears and never move a key to a new destination', async (t) => {
  const server = await startCompanion({ BABATA_TRANSCRIPTION_BASE_URL: 'https://asr.test/v1', BABATA_TRANSCRIPTION_MODEL: 'whisper-test', BABATA_TRANSCRIPTION_API_KEY: 'transcription-secret' });
  t.after(() => server.close());
  let settings = await (await server.request('/settings')).json();
  assert.equal(settings.transcription_provider.api_key, 'transcription-secret');
  const health = await (await server.request('/health')).json();
  assert.equal(health.transcription_provider.api_key_set, true);
  assert.equal(health.transcription_provider.api_key, undefined);
  settings = await (await server.post('/settings', { transcription_provider: { base_url: 'https://other-asr.test/v1' } })).json();
  assert.equal(settings.transcription_provider.api_key_set, false);
  await (await server.post('/settings', { transcription_provider: { base_url: '', api_key: '', model: '' } })).json();
  settings = await (await server.request('/settings')).json();
  assert.deepEqual(settings.transcription_provider, { base_url: '', model: '', api_key: '', api_key_set: false });
});

await test('settings broadcasts only changed provider scopes and never sends provider secrets', async (t) => {
  const server = await startCompanion();
  const socket = new WebSocket(`${server.origin.replace('http:', 'ws:')}/ws?client_id=translation-config-test`, { origin: extensionOrigin });
  await once(socket, 'open');
  t.after(async () => { socket.terminate(); await server.close(); });
  const notices = [];
  socket.on('message', (raw) => notices.push(JSON.parse(raw)));
  await (await server.post('/settings', { translation_provider: { model: 'new-translation-model', api_key: 'secret-one' } })).json();
  await until(() => notices.length === 1);
  assert.deepEqual(notices[0], { kind: 'notification', action: 'translation_config_changed', args: { scope: 'translation' } });
  await (await server.post('/settings', { translation_provider: { model: 'new-translation-model', api_key: 'secret-one' } })).json();
  await delay(25);
  assert.equal(notices.length, 1, 'saving identical settings does not cancel useful translations');
  await (await server.post('/settings', { transcription_provider: { model: 'asr-model', api_key: 'secret-two' } })).json();
  await until(() => notices.length === 2);
  assert.equal(notices[1].args.scope, 'transcription');
  await (await server.post('/settings', { translation_provider: { model: 'another-model' }, transcription_provider: { model: 'another-asr' } })).json();
  await until(() => notices.length === 3);
  assert.equal(notices[2].args.scope, 'all');
  assert.doesNotMatch(JSON.stringify(notices), /secret|model|base_url|api_key/);
});

await test('audio routes use configured provider and preserve multipart boundaries through the shared queue', async (t) => {
  let captured;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'Spoken fixture text.' }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const server = await startCompanion();
  t.after(async () => { await server.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  assert.equal((await (await server.request('/transcribe/capabilities')).json()).available, false);
  await (await server.post('/settings', { transcription_provider: { base_url: `http://127.0.0.1:${upstream.address().port}/v1/audio/transcriptions`, model: 'asr-fixture' } })).json();
  assert.equal((await (await server.request('/transcribe/capabilities')).json()).available, true);
  const response = await server.post('/transcribe', { audio_base64: Buffer.from('audio fixture').toString('base64'), mime: 'audio/webm', duration_seconds: 1 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, 'Spoken fixture text.');
  assert.equal(captured.url, '/v1/audio/transcriptions');
  assert.match(captured.type, /^multipart\/form-data; boundary=/);
  assert.match(captured.body, /name="model"\r\n\r\nasr-fixture/);
  assert.match(captured.body, /audio fixture/);
});

await test('shared provider errors redact echoed credentials across translation and transcription routes', async (t) => {
  const syntheticKey = `fixture-key-${randomUUID()}`;
  const otherSyntheticToken = `fixture-token-${randomUUID()}`;
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the JSON or audio fixture. */ }
    seen.push(req.url);
    const submittedKey = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Rejected key ${submittedKey}; authorization ${req.headers.authorization}; other bEaReR ${otherSyntheticToken}` } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const server = await startCompanion({ BABATA_PROVIDER_MAX_RETRIES: '0' });
  t.after(async () => { await server.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const config = { base_url: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'credential-fixture', api_key: syntheticKey };
  await (await server.post('/settings', { transcription_provider: config })).json();
  for (const [route, body, status] of [
    ['/translate/models', config, 401],
    ['/translate/test', config, 401],
    ['/translate', { translation_provider: config, ...input('Credential redaction fixture.') }, 200],
    ['/transcribe', { audio_base64: Buffer.from('audio fixture').toString('base64'), mime: 'audio/webm', duration_seconds: 1 }, 401],
  ]) {
    const response = await server.post(route, body);
    assert.equal(response.status, status, route);
    const result = await response.json();
    assert.equal(result.ok, false, route);
    const serialized = JSON.stringify(result);
    // Assert booleans so a regression never prints a credential in diagnostics.
    assert.equal(serialized.includes(syntheticKey), false, `${route} must redact the configured key`);
    assert.equal(serialized.includes(otherSyntheticToken), false, `${route} must redact other bearer tokens`);
    assert.equal(serialized.includes('[redacted]'), true, `${route} must retain a redacted error`);
    assert.equal(serialized.includes('provider_http_error'), true, `${route} must preserve the error classification`);
  }
  assert.deepEqual(seen, ['/v1/models', '/v1/chat/completions', '/v1/chat/completions', '/v1/audio/transcriptions']);
});
