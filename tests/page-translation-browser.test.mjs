import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const bundle = (await build({ entryPoints: ['src/content/babata-translate.ts'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;

await test('page translation scheduling and source ownership in an isolated browser', { timeout: 90_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function fixture(body, mode = 'replace', initialResponseMode = 'echo') {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route('https://translation.test/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
    }));
    await page.goto('https://translation.test/');
    await page.evaluate(({ mode, initialResponseMode }) => {
      window.requests = [];
      window.pendingReplies = [];
      window.storageListeners = [];
      window.runtimeListeners = [];
      window.responseMode = initialResponseMode;
      window.version = '译文';
      window.answer = (message) => ({ ok: true, complete: true, results: message.batch.map((item) => ({
        hash: item.hash, translated: `${window.version} ${item.text.replaceAll('Introduction', '介绍')}`,
      })) });
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => runtimeListeners.push(fn), removeListener() {} },
          sendMessage: async (message) => {
            requests.push(message);
            if (message.type !== 'babata.translate') return { ok: true };
            if (new Set(message.batch.map((item) => item.hash)).size !== message.batch.length) return { ok: false, results: [], retryable: false, error: 'duplicate_hash: batch hashes must be unique' };
            if (responseMode === 'repeat-race' && requests.filter((item) => item.type === 'babata.translate').length === 2) return { ok: false, results: [], retryable: false, error: 'A duplicate in-flight transport failed after another subscription succeeded' };
            if (responseMode === 'hold') return await new Promise((resolve) => pendingReplies.push({ message, resolve }));
            if (responseMode === 'permanent') return { ok: false, results: [], retryable: false, errors: message.batch.map((item) => ({ hash: item.hash, code: 'invalid_provider', message: 'Invalid provider', retryable: false })) };
            if (responseMode === 'partial' && !window.partialSent) {
              window.partialSent = true;
              return { ok: false, partial: true, results: answer(message).results.slice(0, 1), errors: message.batch.slice(1).map((item) => ({ hash: item.hash, code: 'missing', message: 'Retry only this item', retryable: true, retry_after_ms: 30 })) };
            }
            if (responseMode === 'html-markers') return { ok: true, results: message.batch.map((item) => ({ hash: item.hash, translated: '阅读 [[BBT_LINK_1]]<strong>介绍</strong>[[/BBT_LINK_1]] 了解详情。' })) };
            return answer(message);
          },
        },
        storage: { local: { get: async () => ({ 'babata.translation_mode': mode }), set: async () => {} }, onChanged: { addListener: (fn) => storageListeners.push(fn), removeListener() {} } },
      };
    }, { mode, initialResponseMode });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addScriptTag({ content: bundle });
    return { page, errors };
  }

  await t.test('only viewport look-ahead is requested and the first paragraph survives a large document', async () => {
    const { page, errors } = await fixture(`<p id="first">The first visible paragraph must be translated immediately.</p><section style="margin-top:100000px">${Array.from({ length: 5002 }, (_, i) => `<p id="far-${i}">Far away paragraph number ${i} contains unique natural language.</p>`).join('')}</section>`);
    await expect(page.locator('#first + .bbt-tr')).toContainText('译文');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).some((item) => item.text.includes('Far away'))), false);
    await page.locator('#far-0').scrollIntoViewIfNeeded();
    await expect(page.locator('#far-0 + .bbt-tr')).toContainText('译文');
    const requested = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).length);
    assert.ok(requested < 100, `expected bounded look-ahead, received ${requested} items`);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('source-only text insertion, CSS churn, removed translations and remounts recover without extra model calls', async () => {
    const { page, errors } = await fixture('<main><p id="original">A stable original paragraph receives a translation exactly once.</p><div id="empty"></div></main>');
    await expect(page.locator('#original + .bbt-tr')).toContainText('译文');
    const initial = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length);
    await page.locator('#original + .bbt-tr').evaluate((node) => node.remove());
    await expect(page.locator('#original + .bbt-tr')).toContainText('译文');
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), initial);
    await page.evaluate(() => {
      const original = document.getElementById('original');
      const replacement = document.createElement('p');
      replacement.id = 'original';
      replacement.textContent = original.textContent;
      original.replaceWith(replacement);
    });
    await expect(page.locator('#original + .bbt-tr')).toContainText('译文');
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), initial);
    await page.evaluate(() => {
      const empty = document.getElementById('empty');
      empty.append(document.createTextNode('A text node was added to an initially empty existing container.'));
      window.churn = setInterval(() => empty.classList.toggle('color-only'), 30);
    });
    await expect(page.locator('#empty + .bbt-tr')).toContainText('译文', { timeout: 2000 });
    await page.evaluate(() => clearInterval(churn));
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('long paragraphs split safely, Japanese translates, and source code and formatting remain local', async () => {
    const { page, errors } = await fixture(`<p id="long">${'A long natural paragraph contains full meaningful sentences. '.repeat(350)}</p><p id="formatted">Read <strong>critical details</strong> and keep <code>const total = price * quantity</code> in the <a href="https://example.test/intro">Introduction</a>.</p><p id="japanese">東京都内の最新技術と研究成果を紹介します。</p>`, 'replace', 'repeat-race');
    await expect(page.locator('#long + .bbt-tr')).toContainText('译文');
    const sizes = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).map((item) => item.text.length));
    assert.ok(sizes.length > 1);
    assert.ok(Math.max(...sizes) < 1600);
    assert.equal(await page.locator('#long + .bbt-tr').evaluate((node) => (node.textContent.match(/\bmeaningful\b/g) || []).length), 350, 'every repeated source chunk must retain its position');
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').some((message) => new Set(message.batch.map((item) => item.hash)).size !== message.batch.length)), false);
    await page.locator('#formatted').evaluate((node) => (node.nextElementSibling?.classList.contains('bbt-tr') ? node.nextElementSibling : node).scrollIntoView());
    await expect(page.locator('#formatted + .bbt-tr strong')).toHaveText('critical details');
    await expect(page.locator('#formatted + .bbt-tr code')).toHaveText('const total = price * quantity');
    await expect(page.locator('#formatted + .bbt-tr a')).toHaveAttribute('href', 'https://example.test/intro');
    await expect(page.locator('#japanese + .bbt-tr')).toContainText('译文');
    assert.equal(await page.evaluate(() => JSON.stringify(requests.filter((m) => m.type === 'babata.translate')).includes('const total = price * quantity')), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('literal marker syntax and explicitly untranslated phrases are preserved as source text', async () => {
    const { page } = await fixture('<p id="literal">The literal [[BBT_LINK_7]] syntax and <span translate="no">Brand Secret Name</span> must stay exactly intact.</p>');
    await expect(page.locator('#literal + .bbt-tr')).toContainText('[[BBT_LINK_7]]');
    await expect(page.locator('#literal + .bbt-tr')).toContainText('Brand Secret Name');
    const sent = await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).map((item) => item.text).join(''));
    assert.equal(sent.includes('Brand Secret Name'), false);
    assert.equal(sent.includes('[[BBT_LINK_7]]'), false);
    await page.close();
  });

  await t.test('link marker pairs survive provider HTML between their endpoints', async () => {
    const { page } = await fixture('<div id="empty"></div>');
    await page.evaluate(() => {
      responseMode = 'html-markers';
      document.getElementById('empty').innerHTML = '<p id="linked">Read the <a href="https://example.test/intro">Introduction</a> for complete details.</p>';
    });
    await expect(page.locator('#linked + .bbt-tr a')).toHaveText('介绍');
    await expect(page.locator('#linked + .bbt-tr a')).toHaveAttribute('href', 'https://example.test/intro');
    assert.equal(await page.locator('#linked + .bbt-tr strong').count(), 0, 'model HTML must not define the display structure');
    await page.close();
  });

  await t.test('partial results keep successes and permanent failures do not loop', async () => {
    const { page } = await fixture('<main id="empty"></main>');
    await page.evaluate(() => {
      responseMode = 'partial';
      document.getElementById('empty').innerHTML = '<p id="one">First partial-result paragraph contains English prose.</p><p id="two">Second partial-result paragraph contains English prose.</p>';
    });
    await expect(page.locator('#one + .bbt-tr')).toContainText('译文');
    await expect(page.locator('#two + .bbt-tr')).toContainText('译文');
    const sent = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).map((item) => item.text));
    assert.equal(sent.filter((text) => text.startsWith('First partial')).length, 1);
    assert.equal(sent.filter((text) => text.startsWith('Second partial')).length, 2);
    await page.evaluate(() => {
      responseMode = 'permanent';
      const p = document.createElement('p');
      p.id = 'permanent'; p.textContent = 'A permanent provider error should not be retried on CSS changes.'; document.body.append(p);
    });
    await expect.poll(() => page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).filter((item) => item.text.startsWith('A permanent')).length)).toBe(1);
    await page.evaluate(() => { window.churn = setInterval(() => document.getElementById('permanent').classList.toggle('color'), 40); });
    await page.waitForTimeout(500);
    await page.evaluate(() => clearInterval(churn));
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).filter((item) => item.text.startsWith('A permanent')).length), 1);
    await page.close();
  });

  await t.test('repeated framework deletions have a bounded repair budget and text changes recover', async () => {
    const { page } = await fixture('<p id="source">A framework keeps deleting the generated translation node.</p>');
    await expect(page.locator('#source + .bbt-tr')).toContainText('译文');
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index++) {
        document.querySelector('#source + .bbt-tr')?.remove();
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
    });
    await expect(page.locator('#source + .bbt-tr')).toHaveCount(0);
    await expect(page.locator('#source')).toBeVisible();
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').length), 1);
    await page.locator('#source').evaluate((node) => { node.textContent = 'New source content can translate after the framework stops deleting nodes.'; });
    await expect(page.locator('#source + .bbt-tr')).toContainText('New source content');
    await page.close();
  });

  await t.test('provider refresh preserves the old render until replacement and off cancels active work', async () => {
    const { page } = await fixture('<p id="source">This paragraph is rendered while the provider configuration changes.</p><section id="empty"></section>');
    await expect(page.locator('#source + .bbt-tr')).toContainText('译文');
    await page.evaluate(() => { responseMode = 'hold'; version = '新译文'; runtimeListeners.forEach((fn) => fn({ type: 'babata.translation_config_changed', scope: 'translation' })); });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBeGreaterThan(0);
    await expect(page.locator('#source + .bbt-tr')).toContainText('译文');
    await expect(page.locator('#source')).toBeHidden();
    await page.evaluate(() => { responseMode = 'echo'; pendingReplies.splice(0).forEach(({ message, resolve }) => resolve(answer(message))); });
    await expect(page.locator('#source + .bbt-tr')).toContainText('新译文');
    await page.evaluate(() => { responseMode = 'hold'; document.getElementById('empty').innerHTML = '<p>A new visible paragraph is deliberately held by the mock provider.</p>'; });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBeGreaterThan(0);
    await page.evaluate(() => storageListeners.forEach((fn) => fn({ 'babata.translation_always_disabled_hosts': { newValue: ['translation.test'] } }, 'local')));
    await expect.poll(() => page.evaluate(() => requests.filter((m) => m.type === 'babata.translate.cancel').length)).toBeGreaterThan(0);
    await expect(page.locator('#source')).toBeVisible();
    await page.close();
  });
});
