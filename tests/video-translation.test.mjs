import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

async function module(entry, globalName) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName });
  const sandbox = vm.createContext({ AbortController, DOMException, setTimeout, clearTimeout, Date });
  vm.runInContext(result.outputFiles[0].text, sandbox);
  return sandbox[globalName];
}
const { SubtitleTranslationScheduler } = await module('src/content/video-translation-scheduler.ts', 'scheduler');
const { CaptionTimeline } = await module('src/content/video-captions.ts', 'captions');
const { parseCaptionBody } = await module('src/content/youtube-captions.ts', 'parser');
const { normalizeTranslationResponse } = await module('src/translation-protocol.ts', 'protocol');
const cues = (count = 80) => Array.from({ length: count }, (_, i) => ({ startMs: i * 2000, endMs: (i + 1) * 2000, text: `Caption number ${i}.` }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function transport() {
  const calls = [];
  const translate = (batch, signal) => new Promise((resolve, reject) => calls.push({ batch, signal, resolve, reject }));
  const done = (call) => call.resolve({ ok: true, results: call.batch.map(({ hash, text }) => ({ hash, translated: `译文 ${text}` })) });
  return { calls, translate, done };
}

await test('current subtitle publishes before a slow speculative batch and repeats share in-flight work', async () => {
  const network = transport();
  let updates = 0;
  const scheduler = new SubtitleTranslationScheduler(network.translate, () => updates++);
  scheduler.setSource('track', cues(), 'en');
  scheduler.update(0);
  assert.equal(network.calls.length, 2);
  assert.equal(network.calls[0].batch.length, 3);
  assert.equal(network.calls[1].batch.length, 8);
  for (let i = 0; i < 10; i++) scheduler.update(0);
  assert.equal(network.calls.length, 2);
  network.done(network.calls[0]);
  await tick();
  assert.equal(scheduler.translated(scheduler.timeline.cues[0]), '译文 Caption number 0.');
  assert.equal(scheduler.translated(scheduler.timeline.cues[4]), undefined);
  assert.equal(updates, 1);
  scheduler.cancel();
});

await test('seek cancels obsolete requests and immediately dispatches the new playhead', async () => {
  const network = transport();
  const scheduler = new SubtitleTranslationScheduler(network.translate, () => {});
  scheduler.setSource('track', cues(), 'en');
  scheduler.update(0);
  const old = network.calls.slice();
  scheduler.seek(100_000);
  assert.ok(old.every(({ signal }) => signal.aborted));
  assert.equal(network.calls[2].batch[0].text, 'Caption number 50.');
  network.done(old[0]);
  await tick();
  assert.equal(scheduler.translated(scheduler.timeline.cues[0]), undefined);
  network.done(network.calls[2]);
  await tick();
  assert.equal(scheduler.translated(scheduler.timeline.cues[50]), '译文 Caption number 50.');
  scheduler.cancel();
});

await test('Chinese captions remain native and never call the provider; configuration changes invalidate finished cache', async () => {
  const network = transport();
  const scheduler = new SubtitleTranslationScheduler(network.translate, () => {});
  scheduler.setSource('zh', [{ startMs: 0, endMs: 2000, text: '这是一段中文原生字幕。' }], 'zh-Hans');
  scheduler.update(0);
  assert.equal(network.calls.length, 0);
  assert.equal(scheduler.translated(scheduler.timeline.cues[0]), '这是一段中文原生字幕。');
  scheduler.setSource('en', cues(1), 'en');
  scheduler.update(0);
  network.done(network.calls[0]);
  await tick();
  scheduler.invalidate();
  assert.equal(network.calls.length, 2);
  scheduler.cancel();
});

await test('partial batches keep ready subtitles and retry only missing identities', async () => {
  const network = transport();
  const scheduler = new SubtitleTranslationScheduler(network.translate, () => {});
  scheduler.setSource('track', cues(3), 'en');
  scheduler.update(0);
  const batch = network.calls[0].batch;
  network.calls[0].resolve({ ok: true, results: [{ hash: batch[0].hash, translated: '第一条' }], retryable: true });
  await tick();
  assert.equal(scheduler.translated(scheduler.timeline.cues[0]), '第一条');
  await new Promise((resolve) => setTimeout(resolve, 1250));
  assert.equal(network.calls.length, 2);
  assert.deepEqual(Array.from(network.calls[1].batch, (item) => item.text), ['Caption number 1.', 'Caption number 2.']);
  scheduler.cancel();
});

await test('normalized HTTP 200 partial envelopes honor item retryability and never retry completed or permanent items', async () => {
  const network = transport();
  const scheduler = new SubtitleTranslationScheduler(network.translate, () => {});
  scheduler.setSource('track', cues(3), 'en');
  scheduler.update(0);
  const batch = network.calls[0].batch;
  const response = normalizeTranslationResponse({
    ok: false, partial: true,
    results: [{ hash: batch[0].hash, translated: '已经完成的字幕' }],
    errors: [
      { hash: batch[1].hash, code: 'missing_result', message: 'Provider omitted result', retryable: true, retry_after_ms: 1300 },
      { hash: batch[2].hash, code: 'invalid_input', message: 'Invalid caption', retryable: false },
    ],
  });
  assert.equal(response.retryable, false, 'HTTP 200 defaults do not override individual transient failures');
  network.calls[0].resolve(response);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(network.calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(network.calls.length, 2);
  assert.deepEqual(Array.from(network.calls[1].batch, (item) => item.text), ['Caption number 1.']);
  network.calls[1].resolve(normalizeTranslationResponse({ ok: false, results: [], errors: [{ hash: batch[1].hash, code: 'rate_limited', retryable: true, retry_after_ms: 0 }] }));
  await new Promise((resolve) => setTimeout(resolve, 2450));
  assert.equal(network.calls.length, 3);
  assert.deepEqual(Array.from(network.calls[2].batch, (item) => item.text), ['Caption number 1.']);
  scheduler.cancel();
});

await test('timeline has exact boundaries, deterministic overlaps, and no 120 ms early/late flicker', () => {
  const timeline = new CaptionTimeline([
    { startMs: 0, endMs: 4000, text: 'Long source' },
    { startMs: 2000, endMs: 3000, text: 'A replacement' },
    { startMs: 5000, endMs: 6000, text: 'Next' },
  ]);
  assert.equal(timeline.indexAt(1999), 0);
  assert.equal(timeline.indexAt(2000), 1);
  assert.equal(timeline.indexAt(3000), 0);
  assert.equal(timeline.indexAt(4000), -1);
  assert.equal(timeline.indexAt(4999), -1);
  assert.equal(timeline.nextIndex(4000), 2);
  const long = new CaptionTimeline(cues(20_000));
  for (const index of [0, 1, 999, 19_999]) assert.equal(long.indexAt(index * 2000 + 1000), index);
});

await test('SRT, escaped text and JSON3 append events preserve valid caption content', () => {
  const srt = parseCaptionBody('1\n00:00:01,000 --> 00:00:02,000\n&lt;safe&gt; &amp; &#x1f431;\n\n2\n00:00:02,000 --> 00:00:03,000\nNext sentence.');
  assert.equal(srt.length, 2);
  assert.equal(srt[0].text, '<safe> & 🐱');
  const appended = parseCaptionBody(JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1500, wWinId: 1, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 1000, dDurationMs: 1500, wWinId: 1, aAppend: 1, segs: [{ utf8: 'world.' }] },
  ] }));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].text, 'Hello world.');
  assert.equal(appended[0].endMs, 2500);
});
