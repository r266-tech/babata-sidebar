import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startCompanion, root } from './companion-fixture.mjs';

// This deliberately takes real wall-clock time. A short or accelerated mock
// cannot exercise Chromium's 30-second service-worker fetch response boundary.
await test('built extension finishes a real 33-second translation through its offscreen document', { timeout: 90000 }, async (t) => {
  const source = 'A slow translation provider should still finish this visible paragraph after more than thirty seconds.';
  const translated = '即使翻译服务响应超过三十秒，这段可见文字也应完整翻译。';
  const requests = [];
  const timers = new Set();
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(body.messages.at(-1).content);
    const record = { receivedAt: performance.now(), repliedAt: null, batch: input.batch };
    requests.push(record);
    // Do not send even the HTTP headers until the full delay has elapsed.
    const timer = setTimeout(() => {
      timers.delete(timer);
      record.repliedAt = performance.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        results: input.batch.map((item) => ({ hash: item.hash, translated })),
      }) } }] }));
    }, 33250);
    timers.add(timer);
    res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const companion = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '50000', BABATA_PROVIDER_MAX_RETRIES: '0' });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'babata-long-translation-'));
  let context;
  t.after(async () => {
    await context?.close();
    await companion.close();
    for (const timer of timers) clearTimeout(timer);
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });
  await (await companion.post('/settings', { translation_provider: {
    base_url: `http://127.0.0.1:${provider.address().port}/v1`, model: 'slow-fixture', api_key: '',
  } })).json();
  const extensionPath = path.join(root, 'dist');
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.BABATA_TEST_BROWSER_PATH ? undefined : 'chromium',
    executablePath: process.env.BABATA_TEST_BROWSER_PATH || undefined,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate((origin) => chrome.storage.local.set({
    'babata.server_origin': origin,
    'babata.translation_mode': 'bilingual',
  }), companion.origin);
  await expect.poll(async () => (await (await companion.request('/health')).json()).sw_attached, { timeout: 10000 }).toBe(true);
  assert.equal(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length), 1);
  await worker.evaluate(() => {
    globalThis.__longTranslationWorkerFetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (new URL(url).pathname === '/translate') globalThis.__longTranslationWorkerFetches++;
      return original(...args);
    };
  });

  const errors = [];
  context.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  context.on('weberror', (event) => errors.push(event.error().message));
  await context.route('https://slow-translation.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Long translation fixture</title></head><body><main><p id="source">${source}</p></main></body></html>`,
  }));
  const page = await context.newPage();
  await page.goto('https://slow-translation.test/article');
  await expect.poll(() => requests.length, { timeout: 10000 }).toBe(1);
  assert.equal(requests[0].batch.length, 1);
  assert.equal(requests[0].batch[0].text, source);

  await delay(Math.max(0, 31000 - (performance.now() - requests[0].receivedAt)));
  assert.equal(requests[0].repliedAt, null, 'provider headers are still withheld past the old 30-second boundary');
  await expect(page.locator('#source')).toBeVisible();
  await expect(page.locator('#source + .bbt-tr')).toHaveCount(0);
  await expect(page.locator('#source + .bbt-tr')).toHaveText(translated, { timeout: 15000 });
  const renderedAt = performance.now();
  assert.ok(requests[0].repliedAt - requests[0].receivedAt >= 33000);
  assert.ok(renderedAt - requests[0].receivedAt >= 33000);
  assert.equal(requests.length, 1, 'the slow request must not be duplicated or retried');
  assert.equal(await worker.evaluate(() => globalThis.__longTranslationWorkerFetches), 0, 'the service worker must never own the long-running translation fetch');
  assert.deepEqual(errors, [], 'browser console and uncaught page errors stay empty');
  const stats = await (await companion.request('/translate/stats')).json();
  assert.equal(stats.provider.attempts, 1);
  assert.equal(stats.provider.retries, 0);
  assert.equal(stats.translation.failed_items, 0);
  t.diagnostic(JSON.stringify({ provider_delay_ms: Math.round(requests[0].repliedAt - requests[0].receivedAt), rendered_after_ms: Math.round(renderedAt - requests[0].receivedAt), provider_requests: requests.length, service_worker_translation_fetches: 0, browser_errors: errors.length }));
});
