import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startCompanion, root } from './companion-fixture.mjs';

await test('chat ownership and settings in an isolated browser', { timeout: 90_000 }, async (t) => {
  const companion = await startCompanion();
  const otherCompanion = await startCompanion();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'babata-chat-browser-'));
  let context;
  t.after(async () => { await context?.close(); await companion.close(); await otherCompanion.close(); await rm(profile, { recursive: true, force: true }); });
  await companion.post('/settings', { translation_provider: { base_url: 'https://provider-one.example/v1', model: 'test-model', api_key: 'fixture-key-one' } });
  await otherCompanion.post('/settings', { translation_provider: { base_url: 'https://provider-two.example/v1', model: 'other-model', api_key: 'fixture-key-two' } });
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
  await context.route('https://window.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Window test page</title></head><body>Isolated page</body></html>' }));
  const sidebar = await context.newPage();
  await sidebar.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
  const windowId = await sidebar.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const historyKey = `babata.chat.history.v1:window:${windowId}`;

  await t.test('a panel without URL parameters uses its actual window history', async () => {
    await expect(sidebar.getByTitle('新对话', { exact: true })).toBeEnabled();
    await sidebar.getByTitle('新对话', { exact: true }).click();
    await expect.poll(async () => worker.evaluate(async (key) => !!(await chrome.storage.local.get(key))[key], historyKey)).toBe(true);
    if (windowId !== 0) {
      assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('babata.chat.history.v1:window:0'))['babata.chat.history.v1:window:0']), undefined);
    }
  });

  await t.test('target broadcasts from another window cannot move an existing panel', async (t) => {
    const otherWindow = await worker.evaluate(() => chrome.windows.create({ url: 'https://window.test/other', focused: false }));
    assert.notEqual(otherWindow.id, windowId);
    t.after(() => worker.evaluate((id) => chrome.windows.remove(id), otherWindow.id).catch(() => {}));
    const otherKey = `babata.chat.history.v1:window:${otherWindow.id}`;
    await worker.evaluate(async ({ historyKey, otherKey }) => {
      await chrome.storage.local.set({
        [historyKey]: { version: 1, updated_at: Date.now(), streaming: false, messages: [{ role: 'user', text: 'Existing window A conversation' }] },
        [otherKey]: { version: 1, updated_at: Date.now(), streaming: false, messages: [{ role: 'user', text: 'Private window B conversation' }] },
      });
    }, { historyKey, otherKey });
    await expect(sidebar.getByText('Existing window A conversation', { exact: true })).toBeVisible();
    await worker.evaluate(({ id, tabId }) => chrome.runtime.sendMessage({ type: 'babata.sidepanel_target', window_id: id, tab_id: tabId }), { id: otherWindow.id, tabId: otherWindow.tabs[0].id });
    await sidebar.waitForTimeout(150);
    await expect(sidebar.getByText('Existing window A conversation', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Private window B conversation', { exact: true })).toHaveCount(0);
    await sidebar.locator('textarea').fill('Message kept in window A');
    await sidebar.locator('textarea').press('Enter');
    await expect(sidebar.getByText('codex fake reply', { exact: true })).toBeVisible();
    const records = await worker.evaluate((keys) => chrome.storage.local.get(keys), [historyKey, otherKey]);
    assert.ok(records[historyKey].messages.some((item) => item.text === 'Message kept in window A'));
    assert.deepEqual(records[otherKey].messages, [{ role: 'user', text: 'Private window B conversation' }]);
  });

  await t.test('clean-read notifications survive a concurrent streaming chat and reload', async () => {
    await sidebar.getByTitle('新对话', { exact: true }).click();
    await sidebar.locator('textarea').fill('SLOW_TEST');
    await sidebar.locator('textarea').press('Enter');
    await expect(sidebar.getByTitle('停止', { exact: true })).toBeVisible();
    await worker.evaluate(async (windowId) => {
      await chrome.runtime.sendMessage({ type: 'babata.notification', action: 'clean_read_started', args: { window_id: windowId, run_id: 'overlap-test', title: 'Parallel article' } });
      await chrome.runtime.sendMessage({ type: 'babata.notification', action: 'clean_read_result', args: { window_id: windowId, run_id: 'overlap-test', markdown: 'Preserved parallel article result' } });
    }, windowId);
    await expect(sidebar.getByText('Preserved parallel article result', { exact: true })).toHaveCount(0);
    await sidebar.getByTitle('停止', { exact: true }).click();
    await expect(sidebar.getByText('Preserved parallel article result', { exact: true })).toBeVisible();
    await expect.poll(async () => worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key]?.messages.some((item) => item.text === 'Preserved parallel article result'), historyKey)).toBe(true);
    await sidebar.reload();
    await expect(sidebar.getByText('SLOW_TEST', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Preserved parallel article result', { exact: true })).toBeVisible();
  });

  await t.test('an old unsaved snapshot cannot resurrect a cleared conversation', async () => {
    await sidebar.getByTitle('新对话', { exact: true }).click();
    await expect(sidebar.getByText('Preserved parallel article result', { exact: true })).toHaveCount(0);
    await worker.evaluate(({ historyKey }) => chrome.runtime.sendMessage({
      type: 'babata.chat.snapshot_error', storage_key: historyKey, turn_id: 'old-finished-turn',
      messages: [{ role: 'assistant', text: 'Stale answer after clearing' }], streaming: false, error: 'Old write failed',
    }), { historyKey });
    await sidebar.waitForTimeout(100);
    await expect(sidebar.getByText('Stale answer after clearing', { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText('Old write failed', { exact: true })).toHaveCount(0);
    const saved = await worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], historyKey);
    assert.deepEqual(saved.messages, []);
  });

  await t.test('editing destinations clears saved keys and requires Companion detection', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options.html`);
    await expect(options.getByLabel('API key', { exact: true })).toHaveValue('fixture-key-one');
    await options.getByLabel('Base URL', { exact: true }).fill('https://unrelated-provider.example/v1');
    await expect(options.getByLabel('API key', { exact: true })).toHaveValue('');
    await options.getByLabel('API key', { exact: true }).fill('fixture-replacement-key');
    await options.getByLabel('Server URL', { exact: true }).fill(otherCompanion.origin);
    await expect(options.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(options.getByRole('button', { name: 'Fetch Models', exact: true })).toBeDisabled();
    await expect(options.getByRole('button', { name: 'Test', exact: true })).toBeDisabled();
    await expect(options.getByRole('button', { name: 'Save Provider', exact: true })).toBeDisabled();
    await options.getByRole('button', { name: 'Detect', exact: true }).click();
    await expect(options.getByLabel('API key', { exact: true })).toHaveValue('fixture-key-two');
    await expect(options.getByLabel('Model', { exact: true })).toHaveValue('other-model');
    await expect(options.getByRole('button', { name: 'Fetch Models', exact: true })).toBeEnabled();
    const stored = await worker.evaluate(() => chrome.storage.local.get('babata.server_origin'));
    assert.equal(stored['babata.server_origin'], companion.origin);
    await options.close();
  });
});
