import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { startCompanion } from './companion-fixture.mjs';

const bundle = (await build({ entryPoints: ['src/content/babata-translate.ts'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;

await test('page request economy through a real companion and HTTP provider', { timeout: 90_000 }, async (t) => {
  const providerRequests = [];
  const providerDelays = new Map();
  const provider = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const outer = JSON.parse(Buffer.concat(chunks).toString());
    const input = JSON.parse(outer.messages.at(-1).content);
    const record = { model: outer.model, texts: input.batch.map((item) => item.text), aborted: false, completed: false };
    providerRequests.push(record);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, providerDelays.get(outer.model) ?? 60);
      res.once('close', () => { clearTimeout(timer); if (!res.writableEnded) record.aborted = true; resolve(); });
    });
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      results: input.batch.map((item) => ({ hash: item.hash, translated: `译文 ${item.text}` })),
    }) } }] }));
    record.completed = true;
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const companion = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '5000', BABATA_PROVIDER_MAX_RETRIES: '0', BABATA_TRANSLATE_CANCEL_GRACE_MS: '400' });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await companion.close(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); });

  const recordsFor = (model) => providerRequests.filter((record) => record.model === model);
  async function fixture(model, body, { hidden = false, beforeBoot } = {}) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const requests = [];
    const controllers = new Map();
    const config = { base_url: `http://127.0.0.1:${provider.address().port}/v1`, model, api_key: '' };
    await page.route('https://economy.test/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><style>body{margin:0}p{margin:0 0 20px}</style></head><body>${body}</body></html>`,
    }));
    await page.goto('https://economy.test/thread');
    await page.exposeFunction('translationBridge', async (message) => {
      if (message.type === 'babata.translate.cancel') {
        requests.push({ cancel: message.request_id });
        controllers.get(message.request_id)?.abort();
        return { ok: true };
      }
      if (message.type !== 'babata.translate') return { ok: true };
      requests.push({ id: message.request_id, texts: message.batch.map((item) => item.text) });
      const controller = new AbortController();
      controllers.set(message.request_id, controller);
      try {
        return await (await companion.post('/translate', { ...message, translation_provider: config }, { signal: controller.signal })).json();
      } catch {
        return { ok: false, retryable: true, results: [], error: 'Fixture request cancelled' };
      } finally { controllers.delete(message.request_id); }
    });
    await page.evaluate((hidden) => {
      window.storageListeners = [];
      window.runtimeListeners = [];
      window.testVisibility = hidden ? 'hidden' : 'visible';
      Object.defineProperty(document, 'visibilityState', { get: () => testVisibility, configurable: true });
      window.chrome = {
        runtime: { onMessage: { addListener: (fn) => runtimeListeners.push(fn), removeListener() {} }, sendMessage: (message) => translationBridge(message) },
        storage: { local: { get: async () => ({ 'babata.translation_mode': 'replace' }), set: async () => {} }, onChanged: { addListener: (fn) => storageListeners.push(fn), removeListener() {} } },
      };
    }, hidden);
    if (beforeBoot) await page.evaluate(beforeBoot);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addScriptTag({ content: bundle });
    return {
      page, requests, errors,
      wireCount: () => requests.filter((request) => request.id).length,
      cancelled: () => requests.filter((request) => request.cancel).length,
      setVisibility: (value) => page.evaluate((value) => { window.testVisibility = value; document.dispatchEvent(new Event('visibilitychange')); }, value),
    };
  }

  await t.test('completed translations reuse L1 across duplicate locations, scrolling, remounts and mode changes', async () => {
    const model = 'completed-reuse';
    const { page, errors, wireCount, setVisibility } = await fixture(model, '<main>' + Array.from({ length: 8 }, (_, i) => `<p id="p${i}">The same meaningful paragraph appears in several places.</p>`).join('') + '<div style="height:5000px"></div></main>');
    await expect(page.locator('.bbt-tr')).toHaveCount(8);
    assert.equal(recordsFor(model).length, 1);
    await page.evaluate(() => scrollTo(0, 4000)); await delay(60); await page.evaluate(() => scrollTo(0, 0));
    for (const mode of ['bilingual', 'replace']) {
      await page.evaluate((mode) => storageListeners.forEach((fn) => fn({ 'babata.translation_mode': { newValue: mode } }, 'local')), mode);
      await expect(page.locator('.bbt-tr')).toHaveCount(8);
    }
    await page.evaluate(() => { const old = document.getElementById('p0'); const replacement = document.createElement('p'); replacement.id = 'p0'; replacement.textContent = old.textContent; old.replaceWith(replacement); });
    await expect(page.locator('#p0 + .bbt-tr')).toContainText('译文');
    await setVisibility('hidden'); await delay(60); await setVisibility('visible');
    for (const hosts of [['economy.test'], []]) await page.evaluate((hosts) => storageListeners.forEach((fn) => fn({ 'babata.translation_always_disabled_hosts': { newValue: hosts } }, 'local')), hosts);
    await expect(page.locator('.bbt-tr')).toHaveCount(8);
    assert.equal(wireCount(), 1);
    assert.equal(recordsFor(model).length, 1);
    assert.deepEqual(errors, []);
    await page.close();
  });

  for (const departure of ['hidden', 'scroll']) await t.test(`a 100ms ${departure} departure keeps one live wire and provider request`, async () => {
    const model = `short-${departure}`;
    providerDelays.set(model, 450);
    const f = await fixture(model, '<p id="source">An in-flight paragraph briefly leaves the user viewport.</p><div style="height:6000px"></div>');
    await expect.poll(() => recordsFor(model).length).toBe(1);
    if (departure === 'hidden') await f.setVisibility('hidden'); else await f.page.evaluate(() => scrollTo(0, 4000));
    await delay(100);
    if (departure === 'hidden') await f.setVisibility('visible'); else await f.page.evaluate(() => scrollTo(0, 0));
    await expect(f.page.locator('#source + .bbt-tr')).toContainText('译文');
    assert.equal(f.wireCount(), 1);
    assert.equal(f.cancelled(), 0);
    assert.equal(recordsFor(model).length, 1);
    assert.equal(recordsFor(model)[0].aborted, false);
    await f.page.close();
  });

  await t.test('hidden sources and documents cannot dispatch queued or newly discovered work', async () => {
    const hiddenSource = await fixture('hidden-source', '<div id="shell"><p id="source">A hidden source must not consume a provider request.</p></div>', {
      beforeBoot: () => {
        const source = document.getElementById('source');
        const observer = new MutationObserver((records) => {
          if (records.some((record) => record.attributeName === 'data-bbt-hash')) { document.getElementById('shell').style.display = 'none'; observer.disconnect(); }
        });
        observer.observe(source, { attributes: true });
      },
    });
    await delay(300);
    assert.equal(hiddenSource.wireCount(), 0);
    assert.equal(recordsFor('hidden-source').length, 0);
    await hiddenSource.page.locator('#shell').evaluate((node) => { node.style.display = ''; });
    await expect(hiddenSource.page.locator('#source + .bbt-tr')).toContainText('译文');
    assert.equal(recordsFor('hidden-source').length, 1, 'showing the source must recover its deferred work');
    await hiddenSource.page.close();

    const hiddenDocument = await fixture('hidden-document', '<main id="main"><p id="source">An initially background document waits before requesting translation.</p></main>', { hidden: true });
    await hiddenDocument.page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'Content mounted while hidden must also wait for the foreground.'; document.getElementById('main').append(p); });
    await delay(300);
    assert.equal(hiddenDocument.wireCount(), 0);
    assert.equal(recordsFor('hidden-document').length, 0);
    await hiddenDocument.setVisibility('visible');
    await expect(hiddenDocument.page.locator('.bbt-tr')).toHaveCount(2);
    const resumedTexts = recordsFor('hidden-document').flatMap((record) => record.texts);
    assert.equal(resumedTexts.length, 2);
    assert.equal(new Set(resumedTexts).size, 2, 'each deferred paragraph must dispatch exactly once');
    await hiddenDocument.page.close();
  });

  await t.test('a response completed while briefly hidden enters cache without dispatching the next batch', async () => {
    const model = 'hidden-completion';
    providerDelays.set(model, 100);
    const f = await fixture(model, '<p id="source">A completed response is useful even while this document is hidden.</p><section id="later"></section>');
    await expect.poll(() => recordsFor(model).length, { intervals: [5] }).toBe(1);
    await f.setVisibility('hidden');
    await f.page.locator('#later').evaluate((node) => { node.innerHTML = '<p id="new">New hidden content must wait while the old response is cached.</p>'; });
    await expect.poll(() => recordsFor(model)[0].completed, { intervals: [5] }).toBe(true);
    await delay(60);
    assert.equal(f.wireCount(), 1);
    assert.equal(recordsFor(model).length, 1);
    await f.setVisibility('visible');
    await expect(f.page.locator('#source + .bbt-tr')).toContainText('译文');
    await expect(f.page.locator('#new + .bbt-tr')).toContainText('译文');
    const sent = recordsFor(model).flatMap((record) => record.texts);
    assert.equal(sent.filter((text) => text.startsWith('A completed response')).length, 1);
    assert.equal(sent.filter((text) => text.startsWith('New hidden content')).length, 1);
    await f.page.close();
  });

  await t.test('long hidden departures eventually cancel and foreground recovery keeps queued paragraphs', async () => {
    const model = 'long-hidden';
    providerDelays.set(model, 2500);
    const f = await fixture(model, '<p id="source">A long background departure should release upstream work.</p><section id="later"></section>');
    await expect.poll(() => recordsFor(model).length).toBe(1);
    await f.setVisibility('hidden');
    await expect.poll(() => recordsFor(model)[0].aborted, { timeout: 2000 }).toBe(true);
    assert.equal(f.cancelled(), 1);
    assert.equal(f.wireCount(), 1);
    await f.page.locator('#later').evaluate((node) => { node.innerHTML = '<p id="new">A newly added background paragraph is not lost on return.</p>'; });
    providerDelays.set(model, 60);
    await f.setVisibility('visible');
    await expect(f.page.locator('#source + .bbt-tr')).toContainText('译文');
    await expect(f.page.locator('#new + .bbt-tr')).toContainText('译文');
    assert.equal(recordsFor(model).length, 2);
    await f.page.close();
  });

  await t.test('switching translation off cancels immediately rather than waiting for the departure debounce', async () => {
    const model = 'explicit-off';
    providerDelays.set(model, 2500);
    const f = await fixture(model, '<p id="source">Explicitly disabling translation must release this subscription immediately.</p>');
    await expect.poll(() => recordsFor(model).length).toBe(1);
    await f.page.evaluate(() => storageListeners.forEach((fn) => fn({ 'babata.translation_always_disabled_hosts': { newValue: ['economy.test'] } }, 'local')));
    await expect.poll(() => f.cancelled(), { timeout: 150, intervals: [5] }).toBe(1);
    await expect.poll(() => recordsFor(model)[0].aborted, { timeout: 2000 }).toBe(true);
    assert.equal(f.wireCount(), 1);
    await f.page.close();
  });

  await t.test('a second document can miss L1 while the companion cache avoids another provider call', async () => {
    const model = 'second-document';
    const body = '<p id="source">The same content should reuse the companion semantic cache on a second visit.</p>';
    const first = await fixture(model, body);
    await expect(first.page.locator('#source + .bbt-tr')).toContainText('译文');
    await first.page.close();
    const second = await fixture(model, body);
    await expect(second.page.locator('#source + .bbt-tr')).toContainText('译文');
    assert.equal(second.wireCount(), 1, 'a new document must ask the companion for its cached value');
    assert.equal(recordsFor(model).length, 1, 'a second visit must not call the model again while L2 is valid');
    await second.page.close();
  });

  await t.test('repeated long-paragraph chunks cross the wire once and retain every source position', async () => {
    const model = 'repeated-chunks';
    providerDelays.set(model, 160);
    const f = await fixture(model, `<p id="source">${'A repeated long natural sentence contains full meaningful words. '.repeat(350)}</p>`);
    await expect(f.page.locator('#source + .bbt-tr')).toContainText('译文');
    const wireTexts = f.requests.filter((request) => request.id).flatMap((request) => request.texts);
    assert.equal(new Set(wireTexts).size, wireTexts.length, 'parallel batches must not send the same chunk twice');
    const providerTexts = recordsFor(model).flatMap((record) => record.texts);
    assert.equal(providerTexts.length, wireTexts.length);
    assert.equal(await f.page.locator('#source + .bbt-tr').evaluate((node) => (node.textContent.match(/meaningful/g) ?? []).length), 350);
    await f.page.close();
  });

  await t.test('a late paragraph shares live chunks and retains them when the original owner unmounts', async () => {
    const model = 'shared-chunk-owners';
    providerDelays.set(model, 450);
    const repeated = 'Shared chunk sentences retain their original sequence and every meaningful word. '.repeat(50);
    const f = await fixture(model, `<p id="first" style="height:80px;overflow:hidden">${repeated}The first distinct ending belongs to the original paragraph.</p><section id="mount"></section>`);
    await expect.poll(() => recordsFor(model).length, { intervals: [5] }).toBeGreaterThan(0);
    await f.page.locator('#mount').evaluate((node, repeated) => {
      const p = document.createElement('p'); p.id = 'second'; p.style.cssText = 'height:80px;overflow:hidden';
      p.textContent = repeated + 'The second distinct ending belongs to the new paragraph.'; node.append(p);
    }, repeated);
    await expect(f.page.locator('#second')).toHaveAttribute('data-bbt-hash', /.+/);
    await f.page.locator('#first').evaluate((node) => node.remove());
    await expect(f.page.locator('#second + .bbt-tr')).toContainText('The second distinct ending');
    assert.equal(await f.page.locator('#second + .bbt-tr').evaluate((node) => (node.textContent.match(/meaningful/g) ?? []).length), 50);
    const wireTexts = f.requests.filter((request) => request.id).flatMap((request) => request.texts);
    assert.equal(new Set(wireTexts).size, wireTexts.length, 'late owners must attach to live chunks without resending them');
    assert.equal(f.cancelled(), 0, 'the new visible owner must keep shared in-flight work alive');
    assert.equal(recordsFor(model).some((record) => record.aborted), false);
    await f.page.close();
  });
});
