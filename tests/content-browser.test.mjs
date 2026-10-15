import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startCompanion, root } from './companion-fixture.mjs';

await test('content lifecycle and site settings in an isolated Chromium profile', { timeout: 90_000 }, async (t) => {
  const companion = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '10000' });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'babata-content-browser-'));
  let browser;
  let provider;
  t.after(async () => {
    try { await browser?.close(); } finally {
      provider?.closeAllConnections();
      provider?.close();
      await companion.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
  const requests = [];
  provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const payload = JSON.parse(body.messages?.at(-1)?.content || '{}');
    requests.push(...(payload.batch || []));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: (payload.batch || []).map((item) => ({ hash: item.hash, translated: `译文 ${item.text}` })) }) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  await companion.post('/settings', { translation_provider: { base_url: `http://127.0.0.1:${provider.address().port}/v1`, model: 'test-model', api_key: '' } });
  const extensionPath = path.join(root, 'dist');
  browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.BABATA_TEST_BROWSER_PATH ? undefined : 'chromium',
    executablePath: process.env.BABATA_TEST_BROWSER_PATH || undefined,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  await worker.evaluate((origin) => chrome.storage.local.set({ 'babata.server_origin': origin }), companion.origin);
  const errors = [];
  browser.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const page = await browser.newPage();
  await browser.route('https://*.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>.collapsed p { display: none; }</style></head><body><main>
    <p id="base">The original paragraph should translate and disappear together with its generated sibling.</p>
    <section id="expand" class="collapsed"><p id="revealed">This paragraph becomes visible when its ancestor changes a CSS class.</p></section>
    <div id="editable" contenteditable>Editable draft content must never be translated.</div>
    <div id="plaintext" contenteditable="plaintext-only">Plaintext editable draft content must also remain intact.</div>
    <section id="dynamic"><p id="dynamic-text">This paragraph will become an editable document after its first translation.</p></section>
    </main></body></html>` }));
  await page.goto('https://alpha.test/article');

  await t.test('editable drafts are excluded and switching to edit mode clears old translations', async () => {
    await expect(page.locator('#base + .bbt-tr')).toContainText('译文');
    await expect(page.locator('#dynamic-text + .bbt-tr')).toContainText('译文');
    assert.equal(requests.some(({ text }) => text.includes('Editable draft') || text.includes('Plaintext editable')), false);
    await expect(page.locator('#editable .bbt-tr, #plaintext .bbt-tr, #editable + .bbt-tr, #plaintext + .bbt-tr')).toHaveCount(0);
    await page.locator('#dynamic').evaluate((element) => element.setAttribute('contenteditable', ''));
    await expect(page.locator('#dynamic .bbt-tr')).toHaveCount(0);
    await expect(page.locator('#dynamic-text')).toBeVisible();
    await page.locator('#dynamic-text').evaluate((element) => { element.textContent = 'A new private editable draft must not reach the translation provider.'; });
    await page.waitForTimeout(1700);
    assert.equal(requests.some(({ text }) => text.includes('new private editable draft')), false);
  });

  await t.test('revealed descendants translate after an ancestor CSS change and removed sources leave no orphan', async () => {
    await expect(page.locator('#revealed')).toBeHidden();
    await page.locator('#expand').evaluate((element) => element.classList.remove('collapsed'));
    await expect(page.locator('#revealed + .bbt-tr')).toContainText('译文');
    await page.locator('#base').evaluate((element) => element.remove());
    await expect(page.locator('.bbt-tr').filter({ hasText: 'original paragraph should translate' })).toHaveCount(0);
  });

  await t.test('clean read handles nested article slots, preserves media and restores original nodes', async () => {
    const reader = await browser.newPage();
    await reader.route('https://nested.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><article><section><div>
      <p id="nested-first"><a id="original-link" href="#">Original article link</a> ${'A detailed paragraph with useful facts for a complete article. '.repeat(15)}</p>
      <p id="nested-second">${'A second detailed paragraph provides further context. '.repeat(15)}</p>
      <p id="media"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="80" height="80">An image caption must retain its media.</p>
    </div></section></article></body></html>` }));
    await reader.goto('https://nested.test/article');
    await expect(reader.locator('#__babata_widget_host__')).toHaveCount(1);
    await expect(reader.locator('#nested-first + .bbt-tr')).toContainText('译文');
    await reader.evaluate(() => { window.originalLink = document.getElementById('original-link'); });
    const tabs = await worker.evaluate(() => chrome.tabs.query({ url: 'https://nested.test/article' }));
    await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'babata.notification', action: 'clean_read_result', args: { markdown: 'Nested clean read summary.\n\nThe remaining article details.', title: 'Nested article' } }), tabs[0].id);
    await expect(reader.locator('#__babata_clean_read_root__')).toHaveCount(1);
    await expect(reader.locator('#nested-first')).toHaveText('Nested clean read summary.');
    await expect(reader.locator('article .bbt-tr')).toHaveCount(0);
    await reader.waitForTimeout(1700);
    assert.equal(requests.some(({ text }) => text.includes('Nested clean read summary.')), false);
    await expect(reader.locator('#media img')).toBeVisible();
    await reader.keyboard.press('Escape');
    assert.equal(await reader.evaluate(() => document.getElementById('original-link') === window.originalLink), true);
    await expect(reader.locator('#nested-first')).toContainText('A detailed paragraph');
    await expect(reader.locator('#nested-first + .bbt-tr')).toContainText('译文');
    await expect(reader.locator('#media img')).toBeVisible();
    await reader.close();
  });

  await t.test('two open widgets merge host changes and refresh live settings without losing exclusions', async () => {
    const other = await browser.newPage();
    await other.goto('https://beta.test/article');
    await expect(other.locator('#base + .bbt-tr')).toContainText('译文');
    // CDP reads the real closed shadow roots; production widget isolation stays intact.
    const sessions = await Promise.all([page, other].map((tab) => browser.newCDPSession(tab)));
    async function widgetControl(session, selector, action = 'read') {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      function find(node) {
        const attrs = Object.fromEntries(Array.from({ length: (node.attributes?.length || 0) / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
        if (Object.entries(selector).every(([key, value]) => attrs[key] === value)) return node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      }
      const node = find(root);
      assert.ok(node, `widget control not found: ${JSON.stringify(selector)}`);
      const { object } = await session.send('DOM.resolveNode', { nodeId: node.nodeId });
      try {
        const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: action === 'click' ? 'function() { this.click(); return this.checked; }' : 'function() { return { checked: this.checked, disabled: this.disabled }; }',
          returnByValue: true,
        });
        assert.equal(exceptionDetails, undefined);
        return result.value;
      } finally { await session.send('Runtime.releaseObject', { objectId: object.objectId }); }
    }
    await Promise.all(sessions.map((session) => widgetControl(session, { title: '翻译设置' }, 'click')));
    await Promise.all(sessions.map((session) => widgetControl(session, { 'data-setting': 'always' }, 'click')));
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('babata.translation_always_disabled_hosts'))['babata.translation_always_disabled_hosts'])).toEqual(['alpha.test', 'beta.test']);
    for (const session of sessions) await expect.poll(async () => (await widgetControl(session, { 'data-setting': 'always' })).checked).toBe(false);
    await worker.evaluate(() => chrome.storage.local.set({
      'babata.translation_always_disabled_hosts': [],
      'babata.translation_mode': 'bilingual',
      'babata.selection_translation_enabled': true,
    }));
    for (const session of sessions) {
      await expect.poll(async () => (await widgetControl(session, { 'data-setting': 'always' })).checked).toBe(true);
      await expect.poll(async () => (await widgetControl(session, { name: 'babata-mode', value: 'bilingual' })).checked).toBe(true);
      await expect.poll(async () => (await widgetControl(session, { 'data-setting': 'selection' })).checked).toBe(true);
      await session.detach();
    }
    await other.close();
  });
  assert.deepEqual(errors, []);
});
