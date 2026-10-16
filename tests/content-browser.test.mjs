import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startCompanion, root } from './companion-fixture.mjs';

// CDP reads the real closed shadow roots; production widget isolation stays intact.
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
      functionDeclaration: action === 'click' ? 'function() { this.click(); return this.checked; }'
        : action === 'geometry' ? 'function() { return this.getBoundingClientRect().toJSON(); }'
          : 'function() { return { checked: this.checked, disabled: this.disabled, label: this.closest("label")?.textContent }; }',
      returnByValue: true,
    });
    assert.equal(exceptionDetails, undefined);
    return result.value;
  } finally { await session.send('Runtime.releaseObject', { objectId: object.objectId }); }
}

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
    const sessions = await Promise.all([page, other].map((tab) => browser.newCDPSession(tab)));
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

  await t.test('the global video switch synchronizes tabs, persists for new pages, and leaves webpage translation independent', async (t) => {
    const tabs = [];
    const sessions = [];
    t.after(async () => {
      for (const session of sessions) await session.detach().catch(() => {});
      for (const tab of tabs) await tab.close();
    });
    // With the key absent, both the widget and the video runtime use enabled.
    await worker.evaluate(() => chrome.storage.local.remove('babata.video_translation_enabled'));
    async function videoPage(name) {
      const tab = await browser.newPage();
      tabs.push(tab);
      await tab.route(`https://video-${name}.test/**`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
        body{margin:16px}video{display:block;width:480px;height:270px;background:#222}
        </style></head><body><main><p id="video-article">The video switch must leave this article paragraph translated on this site.</p>
        <video id="video" muted></video></main><script>
          window.video=document.getElementById('video');
          window.nativeTrack=video.addTextTrack('subtitles','Original English subtitles','en');
          nativeTrack.mode='showing';
          nativeTrack.addCue(new VTTCue(0,30,'Global video settings fixture ${name} caption number 0.'));
        </script></body></html>` }));
      await tab.goto(`https://video-${name}.test/watch`);
      await expect(tab.locator('#__babata_widget_host__')).toHaveCount(1);
      // Method overrides live in an isolated world's DOM wrappers. Install this
      // capture spy in the extension world, where the actual ASR code runs.
      await worker.evaluate(async (url) => {
        const [target] = await chrome.tabs.query({ url });
        await chrome.scripting.executeScript({ target: { tabId: target.id }, func: () => {
          document.documentElement.setAttribute('data-test-capture-calls', '0');
          document.querySelector('video').captureStream = () => {
            const root = document.documentElement;
            root.setAttribute('data-test-capture-calls', String(Number(root.getAttribute('data-test-capture-calls')) + 1));
            throw new Error('Audio capture must require an explicit user action');
          };
        } });
      }, tab.url());
      const session = await browser.newCDPSession(tab);
      sessions.push(session);
      await widgetControl(session, { title: '翻译设置' }, 'click');
      return { tab, session };
    }
    const first = await videoPage('one');
    const second = await videoPage('two');
    for (const { tab, session } of [first, second]) {
      await tab.bringToFront();
      await expect(tab.locator('#video-article + .bbt-tr')).toContainText('译文');
      await expect(tab.locator('.bbt-video-overlay')).toContainText('译文 Global video settings fixture');
      assert.equal(await tab.evaluate(() => nativeTrack.mode), 'hidden');
      const control = await widgetControl(session, { 'data-setting': 'video' });
      assert.equal(control.checked, true);
      assert.match(control.label, /视频翻译/);
    }

    // Disabling this site's webpage translation does not disable its video.
    await first.tab.bringToFront();
    await widgetControl(first.session, { 'data-setting': 'always' }, 'click');
    await expect(first.tab.locator('html')).toHaveAttribute('data-bbt-mode', 'off');
    await expect(first.tab.locator('#video-article + .bbt-tr')).toBeHidden();
    await expect(first.tab.locator('#video-article')).toBeVisible();
    await first.tab.evaluate(() => { nativeTrack.cues[0].text = 'Global video settings fixture one caption number 1.'; nativeTrack.dispatchEvent(new Event('cuechange')); });
    await expect(first.tab.locator('.bbt-video-overlay')).toContainText('译文 Global video settings fixture one caption number 1.');

    await widgetControl(first.session, { 'data-setting': 'video' }, 'click');
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('babata.video_translation_enabled'))['babata.video_translation_enabled'])).toBe(false);
    const videoRequestsWhenDisabled = requests.filter(({ text }) => text.startsWith('Global video settings fixture')).length;
    for (const [index, { tab, session }] of [first, second].entries()) {
      await expect.poll(async () => (await widgetControl(session, { 'data-setting': 'video' })).checked).toBe(false);
      await expect(tab.locator('.bbt-video-overlay')).toBeHidden();
      await expect.poll(() => tab.evaluate(() => nativeTrack.mode)).toBe('showing');
      await tab.evaluate((name) => { nativeTrack.cues[0].text = `Global video settings fixture ${name} caption number 2.`; nativeTrack.dispatchEvent(new Event('cuechange')); }, index === 0 ? 'one' : 'two');
    }
    await expect(second.tab.locator('#video-article + .bbt-tr')).toContainText('译文');
    const third = await videoPage('three');
    await expect(third.tab.locator('#video-article + .bbt-tr')).toContainText('译文');
    await expect.poll(async () => (await widgetControl(third.session, { 'data-setting': 'video' })).checked).toBe(false);
    await expect(third.tab.locator('.bbt-video-overlay')).toBeHidden();
    assert.equal(await third.tab.evaluate(() => nativeTrack.mode), 'showing');
    await third.tab.waitForTimeout(400);
    assert.equal(requests.filter(({ text }) => text.startsWith('Global video settings fixture')).length, videoRequestsWhenDisabled, 'disabled videos and newly opened pages must not issue caption requests');

    // A different tab can re-enable all players without restoring the excluded
    // webpage or implicitly enabling microphone/video-audio transcription.
    await widgetControl(second.session, { 'data-setting': 'video' }, 'click');
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('babata.video_translation_enabled'))['babata.video_translation_enabled'])).toBe(true);
    for (const { tab, session } of [first, second, third]) {
      await tab.bringToFront();
      await expect.poll(async () => (await widgetControl(session, { 'data-setting': 'video' })).checked).toBe(true);
      await expect(tab.locator('.bbt-video-overlay')).toContainText('译文 Global video settings fixture');
      await expect.poll(() => tab.evaluate(() => nativeTrack.mode)).toBe('hidden');
      await expect(tab.locator('html')).toHaveAttribute('data-test-capture-calls', '0');
      await expect(tab.locator('bbt-video-controls button.asr')).toHaveText('听译（无字幕）');
    }
    await expect(first.tab.locator('.bbt-video-overlay')).toContainText('caption number 2.');
    await expect(second.tab.locator('.bbt-video-overlay')).toContainText('caption number 2.');
    await expect(first.tab.locator('#video-article + .bbt-tr')).toBeHidden();
    await expect(second.tab.locator('#video-article + .bbt-tr')).toContainText('译文');
    await expect(third.tab.locator('#video-article + .bbt-tr')).toContainText('译文');
  });

  await t.test('the expanded settings popover stays inside a narrow viewport near the bottom and after resizing', async (t) => {
    await worker.evaluate(() => chrome.storage.local.set({ 'babata.widget.pos': { right: 18, top: 0.8 } }));
    const narrow = await browser.newPage();
    const session = await browser.newCDPSession(narrow);
    t.after(async () => { await session.detach(); await narrow.close(); });
    await narrow.setViewportSize({ width: 390, height: 600 });
    await narrow.goto('https://narrow.test/article');
    await expect(narrow.locator('#__babata_widget_host__')).toHaveCount(1);
    await widgetControl(session, { title: '翻译设置' }, 'click');
    async function assertInsideViewport(width, height) {
      await expect.poll(async () => {
        const box = await widgetControl(session, { class: 'popover' }, 'geometry');
        return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height;
      }).toBe(true);
      const video = await widgetControl(session, { 'data-setting': 'video' }, 'geometry');
      assert.ok(video.left >= 0 && video.top >= 0 && video.right <= width && video.bottom <= height, 'the video switch must stay visible inside the viewport');
    }
    await assertInsideViewport(390, 600);
    await narrow.setViewportSize({ width: 320, height: 420 });
    await assertInsideViewport(320, 420);
  });
  assert.deepEqual(errors, []);
});
