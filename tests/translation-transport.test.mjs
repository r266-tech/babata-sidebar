import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundles = await Promise.all(['src/translation-language.ts', 'src/translation-protocol.ts', 'src/offscreen-translation.ts', 'src/content/translation-client.ts'].map(async (entry) =>
  (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'api' })).outputFiles[0].text,
));
const run = (source, globals = {}) => {
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  return context.api;
};
const copy = (value) => JSON.parse(JSON.stringify(value));

await test('script detection distinguishes Japanese and Korean from Chinese', () => {
  const api = run(bundles[0]);
  for (const text of ['東京都内の最新技術と研究成果を紹介します。', '機械学習の研究結果について説明します。', '한국어 자막입니다.']) {
    assert.equal(api.shouldTranslateText(text), true);
  }
  assert.equal(api.shouldTranslateText('这是一条已经是中文的字幕。'), false);
  assert.equal(api.isTargetLanguage('这个 OpenAI 模型已经支持中文。'), true);
  assert.equal(api.shouldTranslateText('東京都', 'zh', 'ja'), true);
  assert.equal(api.shouldTranslateText('10:32 42%'), false);
});

await test('partial results survive errors and duplicated result IDs never render twice', () => {
  const api = run(bundles[1]);
  const output = copy(api.normalizeTranslationResponse({ ok: false, partial: true,
    results: [{ hash: 'a', translated: '有效译文' }, { hash: 'a', translated: '重复' }, { hash: 'b', translated: '' }],
    errors: [{ hash: 'b', code: 'rate_limit', retryable: true, retry_after_ms: 3000 }],
  }, 429));
  assert.deepEqual(output.results, [{ hash: 'a', translated: '有效译文' }]);
  assert.equal(output.retryable, true);
  assert.equal(output.errors[0].retry_after_ms, 3000);
});

function offscreen(fetchImpl) {
  return run(bundles[2], { URL, AbortController,
    chrome: { runtime: { id: 'fixture-extension' } },
    window: { setTimeout, clearTimeout }, fetch: fetchImpl,
  });
}
const request = (id = 'one', owner = 'tab:1:document-a') => ({ type: 'babata.offscreen.translation.request',
  request_id: id, owner, tab_id: 1, origin: 'http://127.0.0.1:18791', client_id: 'fixture-browser',
  payload: { batch: [{ hash: 'a', text: 'Source text.' }] },
});

await test('offscreen requests preserve useful status and Retry-After from the companion', async () => {
  const api = offscreen(async (url, init) => {
    assert.match(url, /\/translate$/);
    assert.equal(init.headers['x-babata-extension-origin'], 'chrome-extension://fixture-extension');
    return new Response(JSON.stringify({ ok: false, error: 'Busy' }), { status: 429, headers: { 'retry-after': '3' } });
  });
  const result = await api.handleOffscreenTranslation(request());
  assert.equal(result.retry_after_ms, 3000);
  assert.equal(result.retryable, true);
});

await test('cancellation is document-bound and aborts a stalled body', async () => {
  let signal;
  const api = offscreen(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason));
    } }));
  });
  const pending = api.handleOffscreenTranslation(request());
  await api.handleOffscreenTranslation({ type: 'babata.offscreen.translation.cancel', owner: 'tab:2:document-b', request_id: 'one' });
  assert.equal(signal.aborted, false);
  await api.handleOffscreenTranslation({ type: 'babata.offscreen.translation.cancel', owner: 'tab:1:document-a', request_id: 'one' });
  assert.equal((await pending).aborted, true);
  assert.equal(signal.aborted, true);
});

await test('offscreen deadline is retryable while explicit cancellation stays terminal', async () => {
  let expire;
  const api = run(bundles[2], { URL, AbortController,
    chrome: { runtime: { id: 'fixture-extension' } },
    window: { setTimeout: (fn) => { expire = fn; return 1; }, clearTimeout() {} },
    fetch: async (_url, { signal }) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const pending = api.handleOffscreenTranslation(request('deadline'));
  expire();
  const result = await pending;
  assert.equal(result.retryable, true);
  assert.equal(result.aborted, undefined);
  assert.match(result.error, /timed out/);
});

await test('a cancelled request cannot dispatch late and audio uses the separate endpoint', async () => {
  let calls = 0;
  const api = offscreen(async (url) => { calls++; assert.match(url, /\/transcribe$/); return new Response(JSON.stringify({ ok: true, text: 'Spoken text' })); });
  await api.handleOffscreenTranslation({ type: 'babata.offscreen.translation.cancel', owner: 'tab:1:document-a', request_id: 'one' });
  assert.equal((await api.handleOffscreenTranslation(request())).aborted, true);
  assert.equal(calls, 0);
  const result = await api.handleOffscreenTranslation({ ...request('audio'), endpoint: '/transcribe' });
  assert.equal(result.text, 'Spoken text');
  assert.equal(calls, 1);
});

await test('a lost worker message port cancels the content subscription', async () => {
  const messages = [];
  const api = run(bundles[3], { setTimeout, clearTimeout, crypto: { randomUUID: () => 'client-port-lost' },
    chrome: { runtime: { sendMessage: async (message) => {
      messages.push(message);
      if (message.type === 'babata.translate') throw new Error('Message port closed');
      return { ok: true };
    } } },
  });
  await assert.rejects(api.requestTranslation({ batch: [{ hash: 'a', text: 'Source' }] }), /port closed/);
  assert.equal(messages[1].type, 'babata.translate.cancel');
  assert.equal(messages[1].request_id, messages[0].request_id);
});
