import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const captionsBundle = await build({ entryPoints: ['src/content/youtube-captions.ts'], bundle: true, write: false, format: 'iife', globalName: 'captions' });
const context = vm.createContext({});
vm.runInContext(captionsBundle.outputFiles[0].text, context);
const parseCaptions = (body) => JSON.parse(JSON.stringify(context.captions.parseCaptionBody(body)));

await test('malformed, negative and overflowing VTT timestamps are ignored; valid cues are sorted', () => {
  const body = `WEBVTT

00:10.000 --> 00:12.000
Later line

00:02.000 --> 00:04.000 align:start
Earlier line

00:05.000 -->
Missing end

-00:02.000 --> 00:02.000
Negative time

00:70.000 --> 00:80.000
Invalid seconds

${'9'.repeat(307)}:00:00.000 --> ${'9'.repeat(308)}:00:00.000
Overflow
`;
  assert.deepEqual(parseCaptions(body), [
    { startMs: 2000, endMs: 4000, text: 'Earlier line' },
    { startMs: 10000, endMs: 12000, text: 'Later line' },
  ]);
});

await test('JSON3 rejects malformed segments, overflow and oversized cues while retaining valid siblings', () => {
  assert.deepEqual(parseCaptions(JSON.stringify({ events: [
    null,
    { tStartMs: 0, segs: [null] },
    { tStartMs: 0, segs: [{ utf8: 123 }] },
    { tStartMs: 1.7e308, dDurationMs: 1.7e308, segs: [{ utf8: 'Overflow' }] },
    { tStartMs: 0, segs: [{ utf8: 'x'.repeat(12001) }] },
    { tStartMs: 10, dDurationMs: 1000, segs: [{ utf8: '>> <b>Valid</b> line' }] },
  ] })), [{ startMs: 10, endMs: 1010, text: 'Valid line' }]);
});

await test('caption capture ignores unrelated JSON/ASR URLs and failed responses', async () => {
  const mainBundle = await build({ entryPoints: ['src/content/youtube-subtitles-main.ts'], bundle: true, write: false, format: 'iife' });
  const messages = [];
  class FakeXHR { open() {} send() {} }
  const body = JSON.stringify({ events: [] });
  const sandbox = vm.createContext({
    URL, TextDecoder, XMLHttpRequest: FakeXHR, location: { href: 'https://www.youtube.com/watch?v=test' },
    window: {
      addEventListener() {}, postMessage: (message) => messages.push(message),
      fetch: async (url) => new Response(body, { status: url.includes('fail') ? 500 : 200 }),
    },
  });
  vm.runInContext(mainBundle.outputFiles[0].text, sandbox);
  await sandbox.window.fetch('https://example.test/data?fmt=json3&kind=asr');
  await sandbox.window.fetch('https://www.youtube.com/api/timedtext?v=fail');
  await sandbox.window.fetch('https://www.youtube.com/api/timedtext?v=valid');
  await new Promise((resolve) => setTimeout(resolve, 25));
  const captions = messages.filter(({ type }) => type === 'babata.youtube_caption_response');
  assert.equal(captions.length, 1);
  assert.equal(captions[0].url, 'https://www.youtube.com/api/timedtext?v=valid');
  assert.equal(captions[0].response, body);
});
