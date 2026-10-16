import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcribeAudio, transcriptionCapabilities } from '../companion/transcription.mjs';

const provider = { base_url: 'https://audio.example/v1', model: 'transcribe-fixture', api_key: 'test-only' };
const payload = { audio_base64: Buffer.from('fixture audio').toString('base64'), mime: 'audio/webm;codecs=opus', duration_seconds: 12, source: 'en' };

await test('ASR requires explicit configuration and validates input before calling a provider', async () => {
  let calls = 0;
  const send = async () => { calls++; return { text: '' }; };
  assert.equal(transcriptionCapabilities({}).available, false);
  await assert.rejects(transcribeAudio({}, payload, send), /Configure/);
  for (const change of [{ mime: 'text/html' }, { duration_seconds: 26 }, { duration_seconds: 0 }, { audio_base64: 'not base64' }, { audio_base64: 'a'.repeat(6_000_000) }]) {
    await assert.rejects(transcribeAudio(provider, { ...payload, ...change }, send));
  }
  assert.equal(calls, 0);
});

await test('ASR sends a real multipart audio file, preserves cancellation, and bounds timing', async () => {
  const controller = new AbortController();
  const output = await transcribeAudio(provider, payload, async (configured, endpoint, request) => {
    assert.equal(configured, provider);
    assert.equal(endpoint, 'audio/transcriptions');
    assert.equal(request.signal, controller.signal);
    assert.equal(request.priority, 'subtitle');
    assert.equal(request.body.get('model'), provider.model);
    assert.equal(request.body.get('language'), 'en');
    assert.equal(request.body.get('file').name, 'audio.webm');
    assert.equal(await request.body.get('file').text(), 'fixture audio');
    return { text: ' A spoken sentence. ', language: 'english', segments: [
      { start: 1, end: 4, text: ' A spoken sentence. ' },
      { start: 30, end: 40, text: 'Impossible timestamp' },
      { start: -1, end: 5, text: 'Invalid timestamp' },
    ] };
  }, controller.signal);
  assert.equal(output.text, 'A spoken sentence.');
  assert.deepEqual(output.segments, [{ start: 1, end: 4, text: 'A spoken sentence.' }]);
  controller.abort();
  await assert.rejects(transcribeAudio(provider, payload, () => assert.fail('aborted audio reached provider'), controller.signal));
});

await test('silence is a valid empty transcript, while malformed provider output fails', async () => {
  assert.equal((await transcribeAudio(provider, payload, async () => ({ text: '' }))).text, '');
  await assert.rejects(transcribeAudio(provider, payload, async () => ({})), /no text field/);
  await assert.rejects(transcribeAudio(provider, payload, async () => ({ text: 'x'.repeat(20_001) })), /text limit/);
  for (const segments of [
    [{ start: 0, end: 1, text: 'x'.repeat(12_001) }],
    Array.from({ length: 3 }, () => ({ start: 0, end: 1, text: 'x'.repeat(8_000) })),
  ]) await assert.rejects(transcribeAudio(provider, payload, async () => ({ text: 'ok', segments })), /text limit/);
  await assert.rejects(transcribeAudio(provider, payload, async () => ({ text: 'ok', segments: 'invalid' })), /invalid segments/);
});
