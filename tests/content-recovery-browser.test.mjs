import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startCompanion, root } from './companion-fixture.mjs';

await test('extension reload restores page and paused-video translation without navigation, draft loss or duplicate calls', { timeout: 60_000 }, async (t) => {
  const companion = await startCompanion();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'babata-content-recovery-'));
  let context;
  let providerCalls = 0;
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content);
    providerCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      results: input.batch.map((item) => ({ hash: item.hash, translated: `译文 ${item.text}` })),
    }) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(async () => {
    await context?.close();
    await companion.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });
  await companion.post('/settings', { translation_provider: {
    base_url: `http://127.0.0.1:${provider.address().port}/v1`, model: 'recovery-fixture', api_key: '',
  } });
  const extensionPath = path.join(root, 'dist');
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.BABATA_TEST_BROWSER_PATH ? undefined : 'chromium',
    executablePath: process.env.BABATA_TEST_BROWSER_PATH || undefined,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Command-line loading is allowed once without Developer mode, but Chromium
  // disables that same unpacked extension on runtime.reload unless it is on.
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  const developerMode = extensions.locator('extensions-toolbar #devMode');
  if (await developerMode.getAttribute('aria-checked') !== 'true') await developerMode.click();
  await extensions.close();
  await worker.evaluate((origin) => chrome.storage.local.set({
    'babata.server_origin': origin, 'babata.widget.pos': { right: 73, top: 0.31 },
  }), companion.origin);
  async function widget(action = 'read') {
    return worker.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ url: 'https://comments.test/*' });
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [action], func: (action) => {
        const host = document.getElementById('__babata_widget_host__');
        const shadow = host && chrome.dom.openOrClosedShadowRoot(host);
        if (action === 'settings') shadow.querySelector('[title="翻译设置"]').click();
        if (action === 'open') shadow.querySelector('.btn-main').click();
        if (action === 'close') shadow.querySelector('.chat-popup [title="关闭"]').click();
        const root = shadow?.querySelector('.widget');
        return {
          booted: window.__babataWidgetBooted === true,
          waiting: window.__babataWidgetRecoveryWaiting === true,
          popup: Boolean(shadow?.querySelector('.chat-popup')),
          videoSetting: Boolean(shadow?.querySelector('[data-setting="video"]')),
          right: root?.style.right, top: root?.style.top,
        };
      } });
      return frame.result;
    }, action);
  }
  let documentLoads = 0;
  await context.route('https://comments.test/**', (route) => {
    documentLoads++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh"><head><style>
      body{margin:0;font:16px/1.5 sans-serif}main{max-width:800px;margin:auto}.spacer{height:1000px}article{min-height:90px}
      #player{width:640px;height:360px}video{display:block;width:640px;height:360px;background:#222}
    </style></head><body><main><div class="spacer"></div><article role="article"><div id="source" lang="en" data-testid="tweetText"><span>This visible comment should recover when the extension updates.</span></div></article>
    <article role="article"><div id="short" lang="en" data-testid="tweetText"><span>What gave it away?</span></div></article>
    <textarea id="draft" aria-label="Reply draft"></textarea><section id="player"><video id="video" muted></video></section><div class="spacer"></div></main></body></html>` });
  });
  const page = await context.newPage();
  await page.goto('https://comments.test/thread');
  await page.evaluate(() => {
    const video = document.getElementById('video');
    window.nativeTrack = video.addTextTrack('subtitles', 'English fixture', 'en');
    nativeTrack.mode = 'showing';
    nativeTrack.addCue(new VTTCue(0, 30, 'A paused caption should recover after the extension updates.'));
  });
  // Replacement mode can hide #source while Playwright is waiting to scroll.
  // Its article remains visible before and after translation completes.
  await page.locator('article').first().scrollIntoViewIfNeeded();
  await expect(page.locator('#source + .bbt-tr')).toContainText('译文');
  await expect(page.locator('#short + .bbt-tr')).toContainText('译文');
  await page.locator('#draft').fill('An unsent reply must survive the extension update.');
  await page.locator('#video').scrollIntoViewIfNeeded();
  await expect(page.locator('.bbt-video-overlay')).toContainText('译文 A paused caption should recover');
  await expect(page.locator('bbt-video-controls')).toHaveCount(1);
  await expect(page.locator('#__babata_widget_host__')).toHaveCount(1);
  await expect.poll(async () => (await widget()).right).toBe('73px');
  assert.equal(await page.locator('#video').evaluate((video) => video.paused), true);
  const before = await page.evaluate(() => {
    window.originalSource = document.getElementById('source');
    window.originalDraft = document.getElementById('draft');
    window.originalVideo = document.getElementById('video');
    window.originalWidgetHost = document.getElementById('__babata_widget_host__');
    window.originalOverlay = document.querySelector('.bbt-video-overlay');
    window.originalFetch = window.fetch;
    window.originalXhrOpen = XMLHttpRequest.prototype.open;
    window.originalXhrSend = XMLHttpRequest.prototype.send;
    return { scrollY, translations: document.querySelectorAll('.bbt-tr').length };
  });
  const callsBefore = providerCalls;
  const nextWorker = context.waitForEvent('serviceworker', { timeout: 15_000 });
  await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 25); });
  worker = await nextWorker.catch(async (error) => {
    const session = await context.newCDPSession(page);
    const targets = await session.send('Target.getTargets');
    t.diagnostic(JSON.stringify({ workers: context.serviceWorkers().map((item) => item.url()), targets: targets.targetInfos.filter((item) => item.type === 'service_worker' || item.url.startsWith('chrome-extension://')).map(({ type, url }) => ({ type, url })) }));
    throw error;
  });
  await expect.poll(() => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://comments.test/thread' });
    const [frame] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__babataTranslateBooted === true && window.__babataVideoTranslateBooted === true && window.__babataWidgetBooted === true });
    return frame.result;
  }), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('#source + .bbt-tr')).toContainText('译文');
  await expect(page.locator('#short + .bbt-tr')).toContainText('译文');
  await expect(page.locator('#draft')).toHaveValue('An unsent reply must survive the extension update.');
  await expect(page.locator('.bbt-video-overlay')).toHaveCount(1);
  await expect(page.locator('bbt-video-controls')).toHaveCount(1);
  await expect(page.locator('#__babata_widget_host__')).toHaveCount(1);
  assert.equal(await page.evaluate(() => originalWidgetHost !== document.getElementById('__babata_widget_host__')), true);
  await expect.poll(async () => (await widget()).right).toBe('73px');
  assert.equal((await widget('settings')).videoSetting, true, 'an existing page receives the new video translation setting');
  await widget('settings');
  await expect(page.locator('.bbt-video-overlay')).toContainText('译文 A paused caption should recover');
  assert.deepEqual(await page.evaluate(() => ({
    video: originalVideo === document.getElementById('video'),
    paused: originalVideo.paused,
    oldOverlayRemoved: !originalOverlay.isConnected,
    captureBooted: window.__babataVideoCaptionCaptureBooted === true,
    fetchPreserved: originalFetch === window.fetch,
    xhrOpenPreserved: originalXhrOpen === XMLHttpRequest.prototype.open,
    xhrSendPreserved: originalXhrSend === XMLHttpRequest.prototype.send,
  })), { video: true, paused: true, oldOverlayRemoved: true, captureBooted: true, fetchPreserved: true, xhrOpenPreserved: true, xhrSendPreserved: true });
  assert.equal(documentLoads, 1, 'recovery must never navigate or reload the user document');
  assert.deepEqual(await page.evaluate(() => ({ source: originalSource === document.getElementById('source'), draft: originalDraft === document.getElementById('draft') })), { source: true, draft: true });
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - before.scrollY) <= 2, 'recovery preserves the reading position');
  assert.equal(providerCalls, callsBefore, 'already translated text reuses the companion cache after reload');
  await expect(page.locator('.bbt-tr')).toHaveCount(before.translations);

  // SPA content added after recovery is observed by the new context.
  await page.evaluate(() => {
    history.pushState({}, '', '/thread?view=replies');
    const comment = document.createElement('div');
    comment.id = 'new-comment'; comment.lang = 'en'; comment.dataset.testid = 'tweetText';
    comment.textContent = 'A newly mounted reply must also translate without another page load.';
    document.getElementById('short').parentElement.append(comment);
  });
  await expect(page.locator('#new-comment + .bbt-tr')).toContainText('译文');
  assert.equal(documentLoads, 1);
  assert.equal(providerCalls, callsBefore + 1);

  const beforeCaptionChange = (await (await companion.request('/translate/stats')).json()).translation;
  await page.evaluate(() => {
    nativeTrack.cues[0].text = 'A changed paused caption is translated by the recovered engine.';
    nativeTrack.dispatchEvent(new Event('cuechange'));
  });
  await expect(page.locator('.bbt-video-overlay')).toContainText('译文 A changed paused caption');
  await expect(page.locator('.bbt-video-overlay')).toHaveCount(1);
  await expect(page.locator('bbt-video-controls')).toHaveCount(1);
  const afterCaptionChange = (await (await companion.request('/translate/stats')).json()).translation;
  assert.equal(afterCaptionChange.requests - beforeCaptionChange.requests, 1, 'the recovered caption engine submits exactly one companion request');
  assert.equal(afterCaptionChange.items_requested - beforeCaptionChange.items_requested, 1);
  assert.equal(providerCalls, callsBefore + 2);
  assert.equal(documentLoads, 1);

  // An open page-chat iframe is intentionally left in place until its user
  // closes it. Upgrading the surrounding widget must not detach a live draft.
  await widget('open');
  await expect.poll(async () => (await widget()).popup).toBe(true);
  await expect.poll(() => page.frames().some((frame) => frame.url().includes('/src/sidepanel.html'))).toBe(true);
  const chatFrame = page.frames().find((frame) => frame.url().includes('/src/sidepanel.html'));
  await chatFrame.locator('textarea').fill('Unsent chat draft must survive the widget update.');
  const beforeChatReload = await page.evaluate(() => {
    window.chatWidgetHost = document.getElementById('__babata_widget_host__');
    return { scrollY };
  });
  const reloadedWorker = context.waitForEvent('serviceworker', { timeout: 15_000 });
  await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 25); });
  worker = await reloadedWorker;
  await expect.poll(async () => (await widget()).waiting).toBe(true);
  assert.equal(await page.evaluate(() => chatWidgetHost === document.getElementById('__babata_widget_host__')), true);
  assert.equal(chatFrame.isDetached(), false);
  await expect(chatFrame.locator('textarea')).toHaveValue('Unsent chat draft must survive the widget update.');
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - beforeChatReload.scrollY) <= 2);
  assert.equal(documentLoads, 1);
  await widget('close');
  await expect.poll(async () => (await widget()).booted).toBe(true);
  assert.equal((await widget()).waiting, false);
  assert.equal(await page.evaluate(() => chatWidgetHost !== document.getElementById('__babata_widget_host__')), true);
  await expect.poll(async () => (await widget()).right).toBe('73px');
  assert.equal((await widget('settings')).videoSetting, true);
  await expect(page.locator('#__babata_widget_host__')).toHaveCount(1);
  assert.equal(documentLoads, 1);
});
