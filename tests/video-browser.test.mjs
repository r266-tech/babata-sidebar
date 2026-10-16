import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const bundle = (await build({ entryPoints: ['src/content/youtube-subtitles.ts'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;

await test('video captions and explicit audio transcription in Chromium', { timeout: 90_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());

  async function fixture({ cueCount = 80, language = 'en', mode = 'replace', response = 'echo', realMedia = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.route('https://video.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>body{margin:0}main{width:700px;height:950px;padding:25px}video{display:block;width:640px;height:360px;background:#222}</style></head><body><main><video id="video" muted></video></main></body></html>' }));
    await page.goto('https://video.test/watch');
    await page.evaluate(async ({ cueCount, language, mode, response, realMedia }) => {
      window.requests = [];
      window.pendingReplies = [];
      window.storageListeners = [];
      window.runtimeListeners = [];
      window.settings = { 'babata.translation_mode': mode };
      window.responseMode = response;
      window.answer = (message) => ({ ok: true, complete: true, results: message.batch.map((item) => ({ hash: item.hash, translated: `译文 ${item.text}` })) });
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => runtimeListeners.push(fn), removeListener() {} },
          sendMessage: async (message) => {
            requests.push(message);
            if (message.type === 'babata.transcribe.capabilities') return { ok: true, available: true, max_chunk_seconds: 1, max_bytes: 4 * 1024 * 1024 };
            if (message.type === 'babata.transcribe') return { ok: true, text: 'A real audio chunk.', language: 'en', segments: [{ start: 0, end: message.duration_seconds, text: 'A real audio chunk.' }] };
            if (message.type !== 'babata.translate') return { ok: true };
            if (responseMode === 'hold') return await new Promise((resolve) => pendingReplies.push({ message, resolve }));
            return answer(message);
          },
        },
        storage: { local: { get: async () => settings, set: async (values) => Object.assign(settings, values) }, onChanged: { addListener: (fn) => storageListeners.push(fn), removeListener() {} } },
      };
      window.video = document.getElementById('video');
      if (realMedia) {
        window.sourceContext = new AudioContext();
        const oscillator = sourceContext.createOscillator();
        const gain = sourceContext.createGain();
        gain.gain.value = 0.1;
        const destination = sourceContext.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await sourceContext.resume();
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const drawing = canvas.getContext('2d');
        window.drawTimer = setInterval(() => { drawing.fillStyle = `hsl(${performance.now() / 20},50%,40%)`; drawing.fillRect(0, 0, 320, 180); }, 50);
        window.originalStream = new MediaStream([...canvas.captureStream(20).getVideoTracks(), ...destination.stream.getAudioTracks()]);
        video.srcObject = originalStream;
        await video.play();
      } else {
        Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
        window.nativeTrack = video.addTextTrack('subtitles', 'English source', language);
        nativeTrack.mode = 'showing';
        for (let index = 0; index < cueCount; index++) nativeTrack.addCue(new VTTCue(index * 2, (index + 1) * 2, language.startsWith('zh') ? `中文第 ${index} 条字幕。` : `Caption number ${index}.`));
      }
    }, { cueCount, language, mode, response, realMedia });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addScriptTag({ content: bundle });
    return { page, errors };
  }

  await t.test('current cue publishes before held prefetch, stays in one surface, and avoids retranslation on replay', async () => {
    const { page, errors } = await fixture({ response: 'hold' });
    const overlay = page.locator('.bbt-video-overlay');
    await expect(overlay).toContainText('Caption number 0.');
    await expect(overlay).toHaveAttribute('data-state', 'pending');
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    await page.evaluate(() => {
      window.originalOverlay = document.querySelector('.bbt-video-overlay');
      const urgent = pendingReplies.findIndex(({ message }) => message.batch.some((item) => item.text === 'Caption number 0.'));
      const [{ message, resolve }] = pendingReplies.splice(urgent, 1);
      resolve(answer(message));
    });
    await expect(overlay).toHaveAttribute('data-state', 'ready');
    await expect(overlay).toContainText('译文 Caption number 0.');
    assert.equal(await page.evaluate(() => originalOverlay === document.querySelector('.bbt-video-overlay')), true);
    await page.evaluate(() => { video.currentTime = 2; video.dispatchEvent(new Event('timeupdate')); });
    await expect(overlay).toContainText('译文 Caption number 1.');
    await page.evaluate(() => { video.currentTime = 0; video.dispatchEvent(new Event('timeupdate')); });
    await expect(overlay).toContainText('译文 Caption number 0.');
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).filter((item) => item.text === 'Caption number 0.').length), 1);
    const geometry = await page.evaluate(() => ({ overlay: document.querySelector('.bbt-video-overlay').getBoundingClientRect().toJSON(), video: video.getBoundingClientRect().toJSON() }));
    assert.ok(geometry.overlay.top >= geometry.video.top && geometry.overlay.bottom <= geometry.video.bottom, 'captions must anchor inside the video, even in a tall article');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('seek cancels old subscriptions, switch to native restores the original track, and disable cancels work', async () => {
    const { page, errors } = await fixture({ response: 'hold' });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'hidden');
    await page.evaluate(() => { video.dispatchEvent(new Event('seeking')); video.currentTime = 100; video.dispatchEvent(new Event('seeked')); });
    await expect.poll(() => page.evaluate(() => requests.filter((message) => message.type === 'babata.translate.cancel').length)).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.bbt-video-overlay')).toContainText('Caption number 50.');
    await page.evaluate(() => { responseMode = 'echo'; pendingReplies.splice(0).forEach(({ message, resolve }) => resolve(answer(message))); });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 50.');
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByLabel('字幕显示模式').selectOption('off');
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'showing');
    await page.getByLabel('字幕显示模式').selectOption('bilingual');
    await expect(page.locator('.bbt-yt-subtitle-original')).toBeVisible();
    await page.evaluate(() => {
      settings['babata.translation_always_disabled_hosts'] = ['video.test'];
      storageListeners.forEach((listener) => listener({ 'babata.translation_always_disabled_hosts': { newValue: ['video.test'] } }, 'local'));
    });
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'showing');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('Chinese tracks skip translation and untrusted synthetic clicks cannot capture audio', async () => {
    const { page, errors } = await fixture({ cueCount: 1, language: 'zh-Hans' });
    await expect(page.locator('.bbt-video-overlay')).toContainText('中文第 0 条字幕。');
    assert.equal(await page.evaluate(() => requests.some((message) => message.type === 'babata.translate')), false);
    await page.evaluate(() => {
      window.captureCalls = 0;
      video.captureStream = () => { captureCalls++; throw new Error('Unexpected synthetic audio capture'); };
      document.querySelector('bbt-video-controls').shadowRoot.querySelector('.asr').click();
    });
    assert.equal(await page.evaluate(() => captureCalls), 0);
    await page.getByRole('button', { name: '字幕设置' }).click();
    await expect(page.getByRole('status')).toContainText('请亲自点击');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('320 px responsive video keeps captions and settings inside the viewport and Escape returns focus', async () => {
    const { page, errors } = await fixture({ cueCount: 1, mode: 'bilingual' });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addStyleTag({ content: 'main{box-sizing:border-box;width:100%;padding:12px}video{width:100%;height:auto;aspect-ratio:16/9}' });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    const settingsButton = page.getByRole('button', { name: '字幕设置' });
    await settingsButton.click();
    await expect(page.getByLabel('字幕显示模式')).toBeVisible();
    await page.getByLabel('字幕字号').fill('1.6');
    await expect.poll(() => page.evaluate(() => {
      const controls = document.querySelector('bbt-video-controls');
      const panel = controls.shadowRoot.querySelector('.panel');
      const nodes = [video, controls, panel, ...document.querySelectorAll('.bbt-yt-subtitle-line:not([hidden])')];
      const bounds = nodes.map((node) => node.getBoundingClientRect());
      return bounds.every((rect) => rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 0.5 && rect.top >= 0 && rect.bottom <= innerHeight + 0.5)
        && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    await page.getByLabel('字幕显示模式').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('字幕显示模式')).toBeHidden();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    await expect(settingsButton).toBeFocused();
    await expect(page.locator('.bbt-video-overlay')).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('imported cues keep exact gaps, source switching works, and native fullscreen captions restore cleanly', async () => {
    const { page, errors } = await fixture({ cueCount: 4 });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByLabel('选择字幕文件').setInputFiles({ name: 'captions.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:02,000\nImported first line.\n\n2\n00:00:04,000 --> 00:00:06,000\nImported second line.') });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Imported first line.');
    await page.evaluate(() => { video.currentTime = 2; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    await page.evaluate(() => { video.currentTime = 4; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Imported second line.');
    await page.getByLabel('字幕轨道').selectOption({ label: 'English source' });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 2.');
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.evaluate(() => { video.onclick = () => void video.requestFullscreen(); });
    await page.locator('video').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === video)).toBe(true);
    await expect.poll(() => page.evaluate(() => Array.from(video.textTracks).find((track) => track.label === 'babata')?.mode)).toBe('showing');
    assert.equal(await page.evaluate(() => Array.from(video.textTracks).find((track) => track.label === 'babata')?.cues[0].text), '译文 Caption number 2.');
    // A live/native track can refresh while the video itself is fullscreen.
    await page.evaluate(() => { nativeTrack.addCue(new VTTCue(8, 10, 'A newly appended native cue.')); nativeTrack.dispatchEvent(new Event('cuechange')); });
    await page.evaluate(() => document.exitFullscreen());
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByLabel('字幕显示模式').selectOption('off');
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'showing');
    assert.equal(await page.evaluate(() => Array.from(video.textTracks).find((track) => track.label === 'babata')?.mode), 'disabled');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('explicit capture makes independently decodable chunks and stopping preserves source audio', async () => {
    const { page, errors } = await fixture({ realMedia: true, cueCount: 0 });
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByRole('button', { name: '听译（无字幕）', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止听译' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => requests.filter((message) => message.type === 'babata.transcribe').length), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '停止听译' }).click();
    const recorded = await page.evaluate(async () => {
      const decoder = new AudioContext();
      const chunks = [];
      for (const message of requests.filter((message) => message.type === 'babata.transcribe')) {
        const bytes = Uint8Array.from(atob(message.audio_base64), (char) => char.charCodeAt(0));
        const byteLength = bytes.length;
        const decoded = await decoder.decodeAudioData(bytes.buffer);
        chunks.push({ mime: message.mime, declaredDuration: message.duration_seconds, decodedDuration: decoded.duration, byteLength, sequence: message.sequence });
      }
      await decoder.close();
      return { chunks, sourceAudio: originalStream.getAudioTracks().map((track) => track.readyState), paused: video.paused };
    });
    assert.ok(recorded.chunks.length >= 2);
    assert.ok(recorded.chunks.every((chunk) => chunk.byteLength > 100 && chunk.decodedDuration > 0.5 && chunk.decodedDuration < 1.5 && chunk.declaredDuration <= 1.01), JSON.stringify(recorded.chunks));
    assert.deepEqual(recorded.sourceAudio, ['live']);
    assert.equal(recorded.paused, false);
    assert.deepEqual(errors, []);
    await page.evaluate(() => { clearInterval(drawTimer); originalStream.getTracks().forEach((track) => track.stop()); void sourceContext.close(); });
    await page.close();
  });
});
