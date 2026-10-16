import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startCompanion, root } from './companion-fixture.mjs';

await test('built extension in an isolated Chromium profile', { timeout: 120_000 }, async (t) => {
  const companion = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '10000' });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'babata-browser-'));
  let context;
  t.after(async () => { await context?.close(); await companion.close(); await rm(profile, { recursive: true, force: true }); });
  const requests = [];
  let pauseTranslation = false;
  const heldTranslations = new Set();
  const provider = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const content = body.messages?.at(-1)?.content || '{}';
    if (!content.startsWith('{')) {
      res.end(JSON.stringify({ choices: [{ message: { content: '你好，世界。' } }] }));
      return;
    }
    const payload = JSON.parse(content);
    const batch = payload.batch || [];
    requests.push(batch);
    if (pauseTranslation) await new Promise((resolve) => { heldTranslations.add(resolve); });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: batch.map((item) => ({ hash: item.hash, translated: item.text === 'Hello, world.' ? '你好，世界。' : '译文 ' + item.text.replaceAll('Introduction', '介绍') })) }) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => { for (const release of heldTranslations) release(); provider.closeAllConnections(); provider.close(); });
  await companion.post('/settings', { translation_provider: { base_url: `http://127.0.0.1:${provider.address().port}/v1`, model: 'test-model', api_key: '' } });

  const extensionPath = path.join(root, 'dist');
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.BABATA_TEST_BROWSER_PATH ? undefined : 'chromium',
    executablePath: process.env.BABATA_TEST_BROWSER_PATH || undefined,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate((origin) => chrome.storage.local.set({ 'babata.server_origin': origin }), companion.origin);
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const page = await context.newPage();
  await context.route('https://example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <main><p id="first">This paragraph occurs twice on the same page.</p><p id="second">This paragraph occurs twice on the same page.</p>
    <p id="linked">Read the <a href="https://example.test/intro">Introduction</a> for more information about this topic.</p>
    <article id="rich"><h2>A useful article heading</h2><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" style="width:300px;height:200px"><p>Keep this image visible while translating the article content.</p></article>
    </main></body></html>` }));

  await t.test('duplicate paragraphs translate once, every copy renders, and links/media survive', async () => {
    await page.goto('https://example.test/article');
    await expect(page.locator('#first + .bbt-tr')).toContainText('译文');
    await expect(page.locator('#second + .bbt-tr')).toContainText('译文');
    const duplicate = requests.flat().filter((item) => item.text === 'This paragraph occurs twice on the same page.');
    assert.equal(duplicate.length, 1);
    const translatedLink = page.locator('#linked + .bbt-tr a');
    await expect(translatedLink).toHaveAttribute('href', 'https://example.test/intro');
    await expect(translatedLink).toHaveText('介绍');
    await expect(page.locator('#rich img')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelectorAll('.bbt-tr script, .bbt-tr [onerror]').length), 0);
  });

  await t.test('turning translation off stops queued batches and restores the source', async () => {
    pauseTranslation = true;
    const before = requests.length;
    await page.evaluate(() => {
      const section = document.createElement('section');
      for (let i = 0; i < 60; i++) {
        const p = document.createElement('p');
        p.id = `queued-${i}`;
        p.textContent = `Queued paragraph number ${i} has enough English text for translation.`;
        section.append(p);
      }
      document.body.append(section);
    });
    await expect.poll(() => requests.length).toBeGreaterThan(before);
    await worker.evaluate(() => chrome.storage.local.set({ 'babata.translation_always_disabled_hosts': ['example.test'] }));
    await expect(page.locator('html')).toHaveAttribute('data-bbt-mode', 'off');
    const stoppedAt = requests.length;
    pauseTranslation = false;
    for (const release of heldTranslations) release();
    heldTranslations.clear();
    await page.waitForTimeout(650);
    assert.equal(requests.length, stoppedAt);
    await expect(page.locator('#first')).toBeVisible();
    await worker.evaluate(() => chrome.storage.local.set({ 'babata.translation_always_disabled_hosts': [] }));
    await expect(page.locator('#queued-0 + .bbt-tr')).toContainText('译文');
    // Offscreen paragraphs are now intentionally lazy. Reaching the end of
    // the page must translate the newly visible content without eager work.
    await page.locator('#queued-59').scrollIntoViewIfNeeded();
    await expect(page.locator('#queued-59 + .bbt-tr')).toContainText('译文');
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await t.test('page restoration restarts observers after teardown', async () => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('.bbt-tr')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#first + .bbt-tr')).toContainText('译文');
  });

  await t.test('leaving clean read restores original DOM nodes and event listeners', async () => {
    const reader = await context.newPage();
    await reader.route('https://reader.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<html><body><article>
      <h1>A long article with interactive links</h1>
      <p><a id="original-link" href="#">Open details</a> ${'This paragraph contains meaningful article content. '.repeat(10)}</p>
      <p>${'Another paragraph with facts and useful context. '.repeat(10)}</p>
      <p>${'The final paragraph includes the article conclusion. '.repeat(10)}</p>
      </article></body></html>` }));
    await worker.evaluate(() => chrome.storage.local.set({ 'babata.translation_always_disabled_hosts': ['reader.test'] }));
    await reader.goto('https://reader.test/article');
    await expect(reader.locator('#__babata_widget_host__')).toHaveCount(1);
    await reader.evaluate(() => {
      window.originalLink = document.getElementById('original-link');
      window.clickCount = 0;
      window.originalLink.addEventListener('click', (event) => { event.preventDefault(); window.clickCount++; });
    });
    const readerTabs = await worker.evaluate(() => chrome.tabs.query({ url: 'https://reader.test/article' }));
    await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'babata.notification', action: 'clean_read_result', args: { markdown: '## 阅读判定\n\n值得阅读。\n\n## 摘要\n\n测试阅读稿。\n\n## AI 锐评\n\n结构清楚。\n\n## 正文\n\n文章正文。', title: 'Reader' } }), readerTabs[0].id);
    await expect(reader.locator('#__babata_clean_read_root__')).toHaveCount(1);
    await reader.keyboard.press('Escape');
    await expect(reader.locator('#__babata_clean_read_root__')).toHaveCount(0);
    assert.equal(await reader.evaluate(() => document.getElementById('original-link') === window.originalLink), true);
    await reader.locator('#original-link').click();
    assert.equal(await reader.evaluate(() => window.clickCount), 1);
    await reader.close();
  });

  await t.test('YouTube rejects malformed/stale captions, clears navigation, and obeys the site switch', async () => {
    const youtube = await context.newPage();
    let captionBody = '';
    await youtube.route('https://www.youtube.com/**', (route) => route.request().url().includes('/api/timedtext')
      ? route.fulfill({ contentType: 'application/json', body: captionBody })
      : route.fulfill({ contentType: 'text/html', body: '<html><body><div class="html5-video-player" style="position:relative;width:800px;height:500px"><video></video></div></body></html>' }));
    await youtube.goto('https://www.youtube.com/watch?v=video-one');
    async function caption(video, response) {
      captionBody = response;
      await youtube.evaluate((video) => fetch(`https://www.youtube.com/api/timedtext?v=${video}`).then((response) => response.text()), video);
    }
    await caption('video-one', '{"events":42}');
    await caption('video-one', JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 10000, segs: [{ utf8: 'Hello from video one.' }] }] }));
    await expect(youtube.locator('#bbt-youtube-subtitle-overlay')).toBeVisible();
    await youtube.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(youtube.locator('#bbt-youtube-subtitle-overlay')).toBeHidden();
    await youtube.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(youtube.locator('#bbt-youtube-subtitle-overlay')).toBeVisible();
    await youtube.evaluate(() => { history.pushState({}, '', '/watch?v=video-two'); document.dispatchEvent(new Event('yt-navigate-finish')); });
    await expect(youtube.locator('#bbt-youtube-subtitle-overlay')).toBeHidden();
    await caption('video-one', JSON.stringify({ events: [{ segs: [{ utf8: 'A late response from the previous video.' }] }] }));
    await expect(youtube.locator('#bbt-youtube-subtitle-overlay')).toBeHidden();
    await worker.evaluate(() => chrome.storage.local.set({ 'babata.translation_always_disabled_hosts': ['youtube.com'] }));
    await expect(youtube.locator('html')).toHaveAttribute('data-bbt-mode', 'off');
    const before = requests.length;
    await caption('video-two', JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 10000, segs: [{ utf8: 'Hello from video two.' }] }] }));
    await youtube.waitForTimeout(500);
    assert.equal(requests.length, before);
    await expect(youtube.locator('#bbt-youtube-subtitle-overlay')).toBeHidden();
    await youtube.close();
  });

  await t.test('sidebar sends selected CPU and fresh metadata; a cleared chat stays empty after reload', async () => {
    await page.bringToFront();
    const tabs = await worker.evaluate(() => chrome.tabs.query({ url: 'https://example.test/article' }));
    const tab = tabs[0];
    let sidebar = await context.newPage();
    await sidebar.goto(`chrome-extension://${extensionId}/src/sidepanel.html?tab_id=${tab.id}&window_id=${tab.windowId}`);
    await expect(sidebar.locator('textarea')).toBeVisible();
    await sidebar.getByTitle('Prompt 调试', { exact: true }).click();
    await sidebar.locator('textarea').fill('First message');
    await sidebar.locator('textarea').press('Enter');
    await expect(sidebar.getByText('codex fake reply', { exact: true })).toBeVisible();
    // Exercise actual GET history recovery, not just local storage restoration.
    await sidebar.close();
    await worker.evaluate(async () => {
      const records = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(records).filter((key) => key.startsWith('babata.chat.history.v1')));
    });
    const restored = await context.newPage();
    await restored.goto(`chrome-extension://${extensionId}/src/sidepanel.html?tab_id=${tab.id}&window_id=${tab.windowId}`);
    await expect(restored.getByText('codex fake reply', { exact: true })).toBeVisible();
    sidebar = restored;
    await companion.post('/cpu', { cpu: 'grok' });
    await page.evaluate(() => { document.title = 'Updated title for follow-up'; });
    await sidebar.locator('input[type=file]').setInputFiles({ name: 'large-test.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20 * 1024 * 1024, 65) });
    await sidebar.locator('textarea').fill('Follow-up message');
    await sidebar.locator('textarea').press('Enter');
    await expect(sidebar.getByText('codex fake reply', { exact: true })).toHaveCount(2);
    const prompt = sidebar.locator('.bbt-debug-prompt pre').last();
    await expect(prompt).toContainText('https://example.test/article');
    await expect(prompt).toContainText('Updated title for follow-up');
    await expect(prompt).toContainText('large-test.txt');
    await expect(prompt).toContainText('metadata only');
    await sidebar.locator('textarea').fill('Another question on the same page');
    await sidebar.locator('textarea').press('Enter');
    await expect(sidebar.getByText('codex fake reply', { exact: true })).toHaveCount(3);
    await expect(sidebar.locator('.bbt-debug-prompt pre').last()).toContainText('https://example.test/article');
    await expect(sidebar.locator('.bbt-debug-prompt pre').last()).toContainText('"same_page": true');
    await sidebar.setViewportSize({ width: 360, height: 800 });
    if (process.env.BABATA_TEST_SCREENSHOTS) {
      await mkdir(process.env.BABATA_TEST_SCREENSHOTS, { recursive: true });
      await sidebar.screenshot({ path: path.join(process.env.BABATA_TEST_SCREENSHOTS, 'sidebar.png') });
    }
    await sidebar.locator('textarea').fill('SLOW_TEST');
    await sidebar.locator('textarea').press('Enter');
    await expect(sidebar.getByTitle('停止', { exact: true })).toBeVisible();
    await sidebar.getByTitle('停止', { exact: true }).click();
    await expect(sidebar.getByTitle('停止', { exact: true })).toHaveCount(0);
    await sidebar.getByTitle('新对话').click();
    await expect(sidebar.getByText('codex fake reply', { exact: true })).toHaveCount(0);
    await sidebar.reload();
    await expect(sidebar.locator('textarea')).toBeVisible();
    await expect(sidebar.getByText('codex fake reply', { exact: true })).toHaveCount(0);
    await sidebar.setViewportSize({ width: 360, height: 800 });
    assert.ok(await sidebar.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await sidebar.close();
  });

  await t.test('browser reads redact private inputs and stale snapshot clicks cannot target a replacement document', async () => {
    const bridge = await context.newPage();
    await bridge.goto(`chrome-extension://${extensionId}/src/options.html`);
    const tab = (await worker.evaluate(() => chrome.tabs.query({ url: 'https://example.test/article' })))[0];
    await page.evaluate(() => {
      const form = document.createElement('section');
      form.id = 'private-inputs';
      form.innerHTML = '<input type="password" value="private-password-123"><input type="hidden" value="private-csrf-456"><input autocomplete="one-time-code" value="private-otp-789"><input value="readable"><textarea autocomplete="one-time-code">private-otp-789</textarea><template id="nested-private"><template><input type="password" value="private-password-123"></template></template><button id="safe-button">Safe button</button>';
      document.body.prepend(form);
      for (let i = 0; i < 300; i++) form.append(document.createElement('span'));
    });
    const action = (name, args = {}) => bridge.evaluate(async ({ name, args }) => {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { chrome.runtime.onMessage.removeListener(listener); reject(new Error('browser action timed out')); }, 5000);
        function listener(message) {
          if (message.type !== 'babata.ws.outbound') return;
          const result = JSON.parse(message.payload);
          if (result.id !== id) return;
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(result);
        }
        chrome.runtime.onMessage.addListener(listener);
        chrome.runtime.sendMessage({ type: 'babata.ws.inbound', payload: JSON.stringify({ kind: 'request', id, action: name, args }) }).catch(reject);
      });
    }, { name, args: { ...args, tab_id: tab.id } });
    const inputs = await action('dom_query', { selector: 'input,textarea', root: '#private-inputs', props: ['value', 'attrs', 'text', 'html'] });
    const html = await action('dom_query', { selector: '#private-inputs', props: ['html'] });
    const template = await action('dom_query', { selector: '#nested-private', props: ['html'] });
    const snapshot = await action('page_snapshot');
    for (const result of [inputs, html, template, snapshot]) {
      assert.equal(result.ok, true);
      assert.doesNotMatch(JSON.stringify(result), /private-(?:password-123|csrf-456|otp-789)/);
    }
    assert.match(JSON.stringify(inputs), /readable/);
    assert.match(JSON.stringify(inputs), /\[redacted\]/);
    assert.equal((await action('dom_query', { selector: '#private-inputs span', limit: 1e9 })).result.length, 250);
    assert.equal((await action('dom_query', { selector: '#private-inputs span', limit: -1 })).result.length, 1);
    const reference = snapshot.result.items.find((item) => item.selector === '#safe-button').ref;
    await page.reload();
    const stale = await action('page_click_ref', { snapshot_id: snapshot.result.snapshot_id, ref: reference });
    assert.equal(stale.ok, false);
    await bridge.close();
  });

  await t.test('options loads and saves provider settings, fetches models, and validates loopback input', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options.html`);
    await expect(options.getByLabel('Server URL')).toBeEnabled();
    await expect(options.getByText('已连接', { exact: true })).toBeVisible();
    await expect(options.getByLabel('Model', { exact: true })).toHaveValue('test-model');
    await expect(options.getByLabel('Base URL', { exact: true })).toHaveValue(`http://127.0.0.1:${provider.address().port}/v1`);
    assert.equal(await options.locator('header img').evaluate((img) => img.complete && img.naturalWidth > 0), true);
    await options.getByRole('button', { name: 'Fetch Models', exact: true }).click();
    await expect(options.getByText('读取到 1 个模型', { exact: true })).toBeVisible();
    await options.getByRole('button', { name: 'Save Provider', exact: true }).click();
    await expect(options.getByText('已保存并测试通过: 你好，世界。', { exact: true })).toBeVisible();
    if (process.env.BABATA_TEST_SCREENSHOTS) await options.screenshot({ path: path.join(process.env.BABATA_TEST_SCREENSHOTS, 'options.png') });
    await options.getByLabel('Server URL').fill('https://example.test');
    await options.getByText('Save & Detect', { exact: true }).click();
    await expect(options.getByText('仅支持 HTTP localhost 或 127.0.0.1 地址，不含路径和登录信息')).toBeVisible();
    const stored = await worker.evaluate(() => chrome.storage.local.get('babata.server_origin'));
    assert.equal(stored['babata.server_origin'], companion.origin);
    await options.close();
  });
  assert.deepEqual(errors, []);
});
