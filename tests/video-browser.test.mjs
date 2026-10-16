import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const bundle = (await build({ entryPoints: ['src/content/youtube-subtitles.ts'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;
const captureBundle = (await build({ entryPoints: ['src/content/youtube-subtitles-main.ts'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;

function rollingTrackFixtures(count = 20) {
  const cues = Array.from({ length: count }, (_, index) => ({
    start: index * 2, end: index * 2 + 3,
    text: `Synthetic stage ${index + 1} explains an independent instruction.`,
  }));
  const rolling = [{ start: 0, end: 2, text: cues[0].text }];
  for (let index = 1; index < cues.length; index++) {
    rolling.push({ start: index * 2, end: index * 2 + 1, text: `${cues[index - 1].text}\n${cues[index].text}` });
    rolling.push({ start: index * 2 + 1, end: index * 2 + (index === cues.length - 1 ? 3 : 2), text: cues[index].text });
  }
  return [
    { kind: 'subtitles', label: 'English auto-generated', language: 'en', mode: 'showing', cues },
    { kind: 'captions', label: 'clone', language: '', mode: 'hidden', cues: rolling },
  ];
}

await test('video captions and explicit audio transcription in Chromium', { timeout: 90_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());

  async function fixture({ cueCount = 80, language = 'en', mode = 'replace', response = 'echo', realMedia = false, playing = false, videoEnabled = true, disabledHosts = [], capabilities = 'echo', transcription = 'echo', trackFixtures } = {}) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.route('https://video.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>body{margin:0}main{width:700px;height:950px;padding:25px}video{display:block;width:640px;height:360px;background:#222}</style></head><body><main><video id="video" muted></video></main></body></html>' }));
    await page.goto('https://video.test/watch');
    await page.evaluate(async ({ cueCount, language, mode, response, realMedia, playing, videoEnabled, disabledHosts, capabilities, transcription, trackFixtures }) => {
      window.requests = [];
      window.pendingReplies = [];
      window.pendingCapabilities = [];
      window.pendingTranscriptions = [];
      window.storageListeners = [];
      window.runtimeListeners = [];
      window.settings = { 'babata.translation_mode': mode, 'babata.video_translation_enabled': videoEnabled, 'babata.translation_always_disabled_hosts': disabledHosts };
      window.setSettings = (values) => {
        Object.assign(settings, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
        storageListeners.forEach((listener) => listener(changes, 'local'));
      };
      window.responseMode = response;
      window.capabilitiesMode = capabilities;
      window.transcriptionMode = transcription;
      window.answer = (message) => ({ ok: true, complete: true, results: message.batch.map((item) => ({ hash: item.hash, translated: `译文 ${item.text}` })) });
      window.transcriptionAnswer = (message) => ({ ok: true, text: 'A real audio chunk.', language: 'en', segments: [{ start: 0, end: message.duration_seconds, text: 'A real audio chunk.' }] });
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => runtimeListeners.push(fn), removeListener: (fn) => { const at = runtimeListeners.indexOf(fn); if (at >= 0) runtimeListeners.splice(at, 1); } },
          sendMessage: async (message) => {
            requests.push(message);
            if (message.type === 'babata.transcribe.capabilities') {
              if (capabilitiesMode === 'hold') return await new Promise((resolve, reject) => pendingCapabilities.push({ resolve, reject }));
              return { ok: true, available: true, max_chunk_seconds: 1, max_bytes: 4 * 1024 * 1024 };
            }
            if (message.type === 'babata.transcribe') {
              if (transcriptionMode === 'hold') return await new Promise((resolve) => pendingTranscriptions.push({ message, resolve }));
              return transcriptionAnswer(message);
            }
            if (message.type !== 'babata.translate') return { ok: true };
            if (responseMode === 'hold') return await new Promise((resolve) => pendingReplies.push({ message, resolve }));
            return answer(message);
          },
        },
        storage: { local: { get: async () => settings, set: async (values) => Object.assign(settings, values) }, onChanged: { addListener: (fn) => storageListeners.push(fn), removeListener: (fn) => { const at = storageListeners.indexOf(fn); if (at >= 0) storageListeners.splice(at, 1); } } },
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
        Object.defineProperty(video, 'paused', { value: !playing, writable: true });
        if (trackFixtures) {
          window.fixtureTracks = [];
          window.createFixtureTrack = async (source) => {
            const element = document.createElement('track');
            element.kind = source.kind; element.label = source.label; element.srclang = source.language;
            const stamp = (seconds) => {
              const milliseconds = Math.round(seconds * 1000);
              return `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
            };
            const text = `WEBVTT\n\n${source.cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n')}\n\n`;
            const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
            element.src = url;
            try {
              await new Promise((resolve, reject) => {
                element.addEventListener('load', resolve, { once: true });
                element.addEventListener('error', () => reject(new Error('Synthetic WebVTT track failed to load')), { once: true });
                video.append(element);
                element.track.mode = source.mode === 'disabled' ? 'hidden' : source.mode;
              });
            } finally { URL.revokeObjectURL(url); }
            element.track.mode = source.mode;
            fixtureTracks.push(element);
            return element;
          };
          for (const source of trackFixtures) await createFixtureTrack(source);
          window.nativeTrack = fixtureTracks[0].track;
        } else {
          window.nativeTrack = video.addTextTrack('subtitles', 'English source', language);
          nativeTrack.mode = 'showing';
          for (let index = 0; index < cueCount; index++) nativeTrack.addCue(new VTTCue(index * 2, (index + 1) * 2, language.startsWith('zh') ? `中文第 ${index} 条字幕。` : `Caption number ${index}.`));
        }
      }
    }, { cueCount, language, mode, response, realMedia, playing, videoEnabled, disabledHosts, capabilities, transcription, trackFixtures });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addScriptTag({ content: bundle });
    return { page, errors };
  }

  await t.test('current cue publishes before held prefetch, stays in one surface, and avoids retranslation on replay', async () => {
    const { page, errors } = await fixture({ response: 'hold', playing: true });
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
    const toolbar = await page.locator('bbt-video-controls').evaluate((node) => node.shadowRoot.querySelector('.toolbar').getBoundingClientRect().toJSON());
    assert.ok(toolbar.width > 100 && toolbar.height < 45, `toolbar must remain a readable horizontal row: ${JSON.stringify(toolbar)}`);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('seek cancels old subscriptions, switch to native restores the original track, and disable cancels work', async () => {
    const { page, errors } = await fixture({ response: 'hold', playing: true });
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
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': false }));
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'showing');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('global off gates existing and newly discovered videos and cannot be bypassed through local controls', async () => {
    const { page, errors } = await fixture({ videoEnabled: false });
    await page.getByRole('button', { name: '字幕设置' }).click();
    await expect(page.getByRole('status')).toContainText('视频翻译已全局关闭');
    for (const label of ['字幕显示模式', '字幕轨道', '选择字幕文件']) await expect(page.getByLabel(label)).toBeDisabled();
    for (const name of ['视频翻译已全局关闭', '导入字幕', '听译（无字幕）']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    const immediate = await page.evaluate(() => {
      window.captureCalls = 0;
      video.captureStream = () => { captureCalls++; throw new Error('Unexpected disabled audio capture'); };
      const shadow = document.querySelector('bbt-video-controls').shadowRoot;
      shadow.querySelector('.toggle').dispatchEvent(new MouseEvent('click'));
      shadow.querySelector('.mode').value = 'bilingual';
      shadow.querySelector('.mode').dispatchEvent(new Event('change'));
      shadow.querySelector('.asr').dispatchEvent(new MouseEvent('click'));
      shadow.querySelector('.import').dispatchEvent(new MouseEvent('click'));
      const transfer = new DataTransfer();
      transfer.items.add(new File(['1\n00:00:00,000 --> 00:00:02,000\nDisabled imported caption.'], 'disabled.srt'));
      shadow.querySelector('.file').files = transfer.files;
      shadow.querySelector('.file').dispatchEvent(new Event('change'));
      video.currentTime = 20; video.dispatchEvent(new Event('timeupdate'));
      const secondHost = document.createElement('section');
      window.secondVideo = document.createElement('video');
      secondHost.style.cssText = 'position:fixed;left:20px;top:400px;width:300px;height:180px';
      secondVideo.style.cssText = 'width:300px;height:180px';
      Object.defineProperty(secondVideo, 'currentTime', { value: 0, writable: true });
      Object.defineProperty(secondVideo, 'paused', { value: true, writable: true });
      window.secondTrack = secondVideo.addTextTrack('subtitles', 'Second video', 'en');
      secondTrack.mode = 'showing'; secondTrack.addCue(new VTTCue(0, 2, 'Newly discovered caption.'));
      secondHost.append(secondVideo); document.body.append(secondHost);
      return { requests: requests.length, captures: captureCalls, native: nativeTrack.mode };
    });
    assert.deepEqual(immediate, { requests: 0, captures: 0, native: 'showing' });
    await expect(page.locator('bbt-video-controls')).toHaveCount(2);
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => ({ requests: requests.length, native: nativeTrack.mode, second: secondTrack.mode })), { requests: 0, native: 'showing', second: 'showing' });
    await expect(page.locator('.bbt-video-overlay').first()).toBeHidden();
    await expect(page.locator('.bbt-video-overlay').last()).toBeHidden();
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true }));
    await expect(page.locator('.bbt-video-overlay').first()).toContainText('译文 Caption number 10.');
    await expect(page.locator('.bbt-video-overlay').last()).toContainText('译文 Newly discovered caption.');
    assert.equal(await page.evaluate(() => requests.some((message) => message.type.startsWith('babata.transcribe'))), false);
    assert.equal(await page.evaluate(() => requests.some((message) => message.batch?.some((item) => item.text === 'Disabled imported caption.'))), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('page host policy is independent and global off-on preserves each video display preference', async () => {
    const { page, errors } = await fixture({ mode: 'off', disabledHosts: ['video.test'] });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    await page.evaluate(() => setSettings({ 'babata.translation_always_disabled_hosts': [], 'babata.translation_always_hosts': ['video.test'] }));
    await expect(page.locator('.bbt-video-overlay')).toBeVisible();
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByLabel('字幕显示模式').selectOption('bilingual');
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': false }));
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true, 'babata.translation_always_disabled_hosts': ['video.test'] }));
    await expect(page.getByLabel('字幕显示模式')).toHaveValue('bilingual');
    await expect(page.locator('.bbt-yt-subtitle-original')).toBeVisible();
    await page.getByLabel('字幕显示模式').selectOption('off');
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': false }));
    await expect(page.getByLabel('字幕显示模式')).toBeDisabled();
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true }));
    await expect(page.getByLabel('字幕显示模式')).toBeEnabled();
    await expect(page.getByLabel('字幕显示模式')).toHaveValue('off');
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'showing');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('global off cancels in-flight subtitles synchronously while storage is slow and discards late replies', async () => {
    const { page, errors } = await fixture({ response: 'hold', playing: true });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    const stopped = await page.evaluate(() => {
      window.originalStorageGet = chrome.storage.local.get;
      chrome.storage.local.get = () => new Promise((resolve) => { window.resolveStorage = resolve; });
      setSettings({ 'babata.video_translation_enabled': false });
      return { native: nativeTrack.mode, hidden: document.querySelector('.bbt-video-overlay').style.display, cancellations: requests.filter((m) => m.type === 'babata.translate.cancel').length };
    });
    assert.deepEqual(stopped, { native: 'showing', hidden: 'none', cancellations: 2 });
    await page.evaluate(() => {
      pendingReplies.splice(0).forEach(({ message, resolve }) => resolve(answer(message)));
      video.currentTime = 100; video.dispatchEvent(new Event('timeupdate'));
      video.dispatchEvent(new Event('seeked')); video.dispatchEvent(new Event('play'));
      runtimeListeners.forEach((listener) => listener({ type: 'babata.translation_config_changed', scope: 'all' }));
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), 2);
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    await page.evaluate(() => { chrome.storage.local.get = originalStorageGet; resolveStorage({ ...settings }); });
    await page.evaluate(() => { responseMode = 'echo'; setSettings({ 'babata.video_translation_enabled': true }); });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 50.');
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate')[2].batch[0].text), 'Caption number 50.');
    assert.equal(await page.evaluate(() => requests.some((m) => m.type.startsWith('babata.transcribe'))), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('an import already reading when globally disabled cannot revive itself after off-on', async () => {
    const { page, errors } = await fixture();
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    await page.evaluate(() => { File.prototype.text = () => new Promise((resolve) => { window.resolveImportedText = resolve; }); });
    await page.getByLabel('选择字幕文件').setInputFiles({ name: 'late.srt', mimeType: 'text/plain', buffer: Buffer.from('pending') });
    await expect.poll(() => page.evaluate(() => typeof resolveImportedText)).toBe('function');
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': false }));
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true }));
    await expect(page.locator('.bbt-video-overlay')).toBeVisible();
    await page.evaluate(() => resolveImportedText('1\n00:00:00,000 --> 00:00:02,000\nLate imported caption.'));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => requests.some((m) => m.batch?.some((item) => item.text === 'Late imported caption.'))), false);
    assert.equal(await page.getByLabel('字幕轨道').locator('option').filter({ hasText: 'late.srt' }).count(), 0);
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

  await t.test('paused videos request only the visible current cue and play restores bounded prefetch', async () => {
    const { page, errors } = await fixture();
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    await page.evaluate(() => {
      for (const [name, style] of [['hidden', 'display:none'], ['below', 'margin-top:4000px']]) {
        const host = document.createElement('section'); host.id = name; host.style.cssText = style;
        const child = document.createElement('video'); child.style.cssText = 'width:640px;height:360px';
        Object.defineProperty(child, 'currentTime', { value: 0, writable: true });
        Object.defineProperty(child, 'paused', { value: true, writable: true });
        const track = child.addTextTrack('subtitles', name, 'en'); track.mode = 'showing';
        for (let index = 0; index < 80; index++) track.addCue(new VTTCue(index * 2, index * 2 + 1.8, `${name} caption ${index}.`));
        host.append(child); document.body.append(host);
      }
    });
    await expect(page.locator('bbt-video-controls')).toHaveCount(3);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).length), 1);
    await page.locator('#below video').scrollIntoViewIfNeeded();
    await expect(page.locator('#below .bbt-video-overlay')).toContainText('译文 below caption 0.');
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).length), 2);
    await page.locator('#below video').evaluate((node) => { node.paused = false; node.dispatchEvent(new Event('play')); });
    await expect.poll(() => page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).filter((item) => item.text.startsWith('below')).length)).toBe(18);
    await page.locator('#below video').evaluate((node) => { node.paused = true; node.dispatchEvent(new Event('pause')); node.currentTime = 100; node.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('#below .bbt-video-overlay')).toContainText('译文 below caption 50.');
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).filter((item) => item.text.startsWith('below')).length), 19);
    assert.equal(await page.evaluate(() => requests.some((m) => m.batch?.some((item) => item.text.startsWith('hidden')))), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('same-cue seeks reuse pending work and off-on starts at the current position', async () => {
    const { page, errors } = await fixture({ response: 'hold' });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(1);
    for (const time of [0.1, 0.2, 0.3]) await page.evaluate((time) => { video.dispatchEvent(new Event('seeking')); video.currentTime = time; video.dispatchEvent(new Event('seeked')); }, time);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), 1);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate.cancel').length), 0);
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByLabel('字幕显示模式').selectOption('off');
    await page.evaluate(() => { video.currentTime = 100; video.dispatchEvent(new Event('timeupdate')); });
    await page.getByLabel('字幕显示模式').selectOption('replace');
    await expect(page.locator('.bbt-video-overlay')).toContainText('Caption number 50.');
    const texts = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).map((item) => item.text));
    assert.deepEqual(texts, ['Caption number 0.', 'Caption number 50.']);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a completed old batch cannot dispatch more of the old window while seeking', async () => {
    const { page, errors } = await fixture({ response: 'hold', playing: true });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    await page.evaluate(() => {
      video.dispatchEvent(new Event('seeking')); video.currentTime = 100;
      const { message, resolve } = pendingReplies.shift(); resolve(answer(message));
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), 2);
    await page.evaluate(() => video.dispatchEvent(new Event('seeked')));
    await expect.poll(() => page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length)).toBe(4);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate')[2].batch[0].text), 'Caption number 50.');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a media reset during seek releases dispatch suspension without requiring the old seeked event', async () => {
    const { page, errors } = await fixture({ response: 'hold' });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(1);
    await page.evaluate(() => {
      video.dispatchEvent(new Event('seeking'));
      Object.defineProperty(video, 'currentSrc', { value: 'https://video.test/second.mp4', configurable: true });
      nativeTrack.cues[0].text = 'The new media starts with this caption.';
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    assert.equal(await page.evaluate(() => pendingReplies.at(-1).message.batch[0].text), 'The new media starts with this caption.');
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate.cancel').length), 1);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('document hidden state suspends pending work and visibility resumes at the current cue', async () => {
    const { page, errors } = await fixture({ response: 'hold', playing: true });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); video.currentTime = 100; video.dispatchEvent(new Event('timeupdate'));
    });
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate.cancel').length), 2);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), 2);
    await page.evaluate(() => {
      video.paused = true; Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(3);
    assert.deepEqual(await page.evaluate(() => pendingReplies.at(-1).message.batch.map((item) => item.text)), ['Caption number 50.']);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('hiding the video itself removes floating captions and restores them from cache on reveal', async () => {
    const { page, errors } = await fixture();
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    const count = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length);
    for (const property of ['visibility', 'display']) {
      await page.locator('video').evaluate((node, property) => { node.style[property] = property === 'display' ? 'none' : 'hidden'; }, property);
      await expect(page.locator('.bbt-video-overlay')).toBeHidden();
      await page.locator('video').evaluate((node, property) => { node.style[property] = ''; }, property);
      await expect(page.locator('.bbt-video-overlay')).toBeVisible();
      await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    }
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), count);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a paused video revealed by its own or an ancestor opacity transition starts at the current cue', async () => {
    const { page, errors } = await fixture();
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    for (const ancestor of [false, true]) {
      await page.evaluate((ancestor) => {
        const target = ancestor ? video.parentElement : video;
        target.style.transition = ''; target.style.opacity = '0';
      }, ancestor);
      await expect(page.locator('.bbt-video-overlay')).toBeHidden();
      await page.evaluate((ancestor) => {
        video.currentTime += 2; video.dispatchEvent(new Event('timeupdate'));
        const target = ancestor ? video.parentElement : video;
        target.style.transition = 'opacity 100ms linear';
        void target.offsetWidth; target.style.opacity = '1';
      }, ancestor);
      await expect(page.locator('.bbt-video-overlay')).toBeVisible();
      await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 Caption number ${ancestor ? 2 : 1}.`);
    }
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).length), 3);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a corrected middle native cue replaces its cached translation without retranslating unchanged cues', async () => {
    const { page, errors } = await fixture({ cueCount: 3 });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    await page.evaluate(() => { video.currentTime = 2; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 1.');
    await page.evaluate(() => { nativeTrack.cues[1].text = 'The corrected middle caption.'; nativeTrack.dispatchEvent(new Event('cuechange')); });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 The corrected middle caption.');
    const texts = await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').flatMap((m) => m.batch).map((item) => item.text));
    assert.deepEqual(texts, ['Caption number 0.', 'Caption number 1.', 'The corrected middle caption.']);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a rolling clone has one canonical option and never translates duplicate combinations', async (t) => {
    const sources = rollingTrackFixtures();
    sources[0].mode = 'hidden';
    sources[1].mode = 'showing';
    const { page, errors } = await fixture({ trackFixtures: sources, playing: true });
    t.after(() => page.close());
    await page.getByRole('button', { name: '字幕设置' }).click();
    const select = page.getByLabel('字幕轨道');
    await expect(select.locator('option')).toHaveText(['English auto-generated']);
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);
    await expect.poll(() => page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length)).toBe(18);
    await page.evaluate(() => { video.currentTime = 34; video.dispatchEvent(new Event('timeupdate')); });
    await expect.poll(() => page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length)).toBe(20);
    await page.evaluate(() => { video.currentTime = 2.5; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[1].text}`);
    const texts = await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).map((item) => item.text));
    assert.deepEqual(texts.slice().sort(), sources[0].cues.map((cue) => cue.text).sort(), 'only the twenty original sentences reach translation, once each');
    assert.equal(await page.evaluate(() => video.textTracks.length), 2, 'folding the menu must preserve both physical tracks');

    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': false }));
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    assert.deepEqual(await page.evaluate(() => fixtureTracks.map((element) => element.track.mode)), ['hidden', 'showing']);
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true }));
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[1].text}`);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length), 20);
    assert.deepEqual(errors, []);
  });

  await t.test('rolling clone folding preserves explicit languages and same-label tracks with different content', async (t) => {
    const sources = rollingTrackFixtures();
    sources.push({ ...sources[0], label: 'Deutsch', language: 'de', mode: 'hidden', cues: sources[0].cues.map((cue, index) => ({ ...cue, text: `Synthetischer Schritt ${index + 1} erläutert eine eigenständige Anweisung.` })) });
    sources.push({ ...sources[0], mode: 'hidden', cues: sources[0].cues.map((cue, index) => ({ ...cue, text: `Different commentary line ${index + 1} explains another idea.` })) });
    const { page, errors } = await fixture({ trackFixtures: sources });
    t.after(() => page.close());
    await page.getByRole('button', { name: '字幕设置' }).click();
    const select = page.getByLabel('字幕轨道');
    await expect(select.locator('option')).toHaveText(['English auto-generated', 'Deutsch', 'English auto-generated']);
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);
    await select.selectOption({ label: 'Deutsch' });
    await expect.poll(() => page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length)).toBe(2);
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Synthetischer Schritt 1 erläutert eine eigenständige Anweisung.');
    await select.selectOption(await select.locator('option').nth(2).getAttribute('value'));
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Different commentary line 1 explains another idea.');
    assert.equal(await page.evaluate(() => video.textTracks.length), 4);
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length), 3);
    assert.deepEqual(errors, []);
  });

  await t.test('an ambiguous rolling clone stays independent when different declared languages share its transcript', async (t) => {
    const sources = rollingTrackFixtures();
    sources.push({ ...sources[0], label: 'Deutsch', language: 'de', mode: 'hidden' });
    const { page, errors } = await fixture({ trackFixtures: sources });
    t.after(() => page.close());
    await page.getByRole('button', { name: '字幕设置' }).click();
    const select = page.getByLabel('字幕轨道');
    await expect(select.locator('option')).toHaveText(['English auto-generated', 'clone', 'Deutsch']);
    await select.selectOption({ label: 'clone' });
    await page.evaluate(() => { video.currentTime = 2.5; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[0].text);
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[1].text);
    assert.deepEqual(errors, []);
  });

  await t.test('a selected rolling clone keeps its request identity when the original track arrives later', async (t) => {
    const sources = rollingTrackFixtures();
    const { page, errors } = await fixture({ trackFixtures: [{ ...sources[1], mode: 'showing' }] });
    t.after(() => page.close());
    await page.getByRole('button', { name: '字幕设置' }).click();
    const select = page.getByLabel('字幕轨道');
    await expect(select.locator('option')).toHaveText(['clone']);
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);
    await page.evaluate(() => { video.currentTime = 2.5; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[1].text);
    const count = await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length);
    assert.equal(count, 2);
    await page.evaluate(async (source) => {
      const element = await createFixtureTrack({ ...source, mode: 'hidden' });
      element.track.dispatchEvent(new Event('cuechange'));
    }, sources[0]);
    await expect(select.locator('option')).toHaveText(['English auto-generated']);
    assert.notEqual(await select.inputValue(), '');
    await select.selectOption({ label: 'English auto-generated' });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).length), count, 'adding the canonical option and selecting its current row must not change the active request identity');
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[0].text);
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[1].text);
    assert.deepEqual(errors, []);
  });

  await t.test('a folded rolling clone remains watched and becomes selectable after text or timing changes', async (t) => {
    const sources = rollingTrackFixtures();
    const { page, errors } = await fixture({ trackFixtures: sources });
    t.after(() => page.close());
    await page.getByRole('button', { name: '字幕设置' }).click();
    const select = page.getByLabel('字幕轨道');
    await expect(select.locator('option')).toHaveText(['English auto-generated']);
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);
    await page.evaluate(() => {
      const track = fixtureTracks[1].track;
      window.originalCloneText = track.cues[0].text;
      track.cues[0].text = 'A live clone correction supplies a different sentence.';
      track.dispatchEvent(new Event('cuechange'));
    });
    await expect(select.locator('option')).toHaveText(['English auto-generated', 'clone']);
    await select.selectOption({ label: 'clone' });
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 A live clone correction supplies a different sentence.');
    await page.evaluate(() => {
      const track = fixtureTracks[1].track;
      track.cues[0].text = originalCloneText;
      track.dispatchEvent(new Event('cuechange'));
    });
    await expect(select.locator('option')).toHaveText(['English auto-generated']);
    assert.notEqual(await select.inputValue(), '', 'rejoining the canonical track must leave a selected visible option');
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);

    await page.evaluate(() => {
      const track = fixtureTracks[1].track;
      for (const cue of Array.from(track.cues)) { cue.endTime += 5; cue.startTime += 5; }
      track.dispatchEvent(new Event('cuechange'));
    });
    await expect(select.locator('option')).toHaveText(['English auto-generated', 'clone']);
    assert.equal(await select.locator('option:checked').textContent(), 'clone', 'a track that separates again must preserve the user-selected underlying source');
    await select.selectOption({ label: 'clone' });
    await page.evaluate(() => { video.currentTime = 5.5; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);
    assert.equal(await select.locator('option:checked').textContent(), 'clone');
    assert.deepEqual(errors, []);
  });

  await t.test('removing the original DOM track promotes its rolling clone and restores the clone native mode when off', async (t) => {
    const sources = rollingTrackFixtures();
    sources[1].mode = 'showing';
    const { page, errors } = await fixture({ trackFixtures: sources });
    t.after(() => page.close());
    await page.getByRole('button', { name: '字幕设置' }).click();
    const select = page.getByLabel('字幕轨道');
    await expect(select.locator('option')).toHaveText(['English auto-generated']);
    await expect(page.locator('.bbt-video-overlay')).toContainText(`译文 ${sources[0].cues[0].text}`);
    await page.evaluate(() => fixtureTracks[0].remove());
    await expect.poll(() => page.evaluate(() => video.textTracks.length)).toBe(1);
    await expect(select.locator('option')).toHaveText(['clone']);
    assert.notEqual(await select.inputValue(), '', 'removing the canonical DOM track must select the remaining clone');
    await select.selectOption({ label: 'clone' });
    await page.evaluate(() => { video.currentTime = 2.5; video.dispatchEvent(new Event('timeupdate')); });
    await expect(page.locator('.bbt-video-overlay')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[0].text);
    await expect(page.locator('.bbt-video-overlay')).toContainText(sources[0].cues[1].text);
    assert.ok(await page.evaluate(() => requests.filter((message) => message.type === 'babata.translate').flatMap((message) => message.batch).some((item) => item.text.includes('Synthetic stage 1 ') && item.text.includes('Synthetic stage 2 '))), 'the remaining clone must actually translate its rolling caption');
    await page.getByLabel('字幕显示模式').selectOption('off');
    await expect(page.locator('.bbt-video-overlay')).toBeHidden();
    assert.equal(await page.evaluate(() => fixtureTracks[1].track.mode), 'showing');
    assert.deepEqual(errors, []);
  });

  await t.test('reinjecting scripts is idempotent and a replacement world tears down the old video controller', async () => {
    const { page, errors } = await fixture({ response: 'hold' });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(1);
    await page.addScriptTag({ content: bundle });
    assert.equal(await page.evaluate(() => pendingReplies.length), 1);
    await expect(page.locator('bbt-video-controls')).toHaveCount(1);
    await page.evaluate(() => { window.__babataVideoTranslateBooted = false; });
    await page.addScriptTag({ content: bundle });
    await expect.poll(() => page.evaluate(() => pendingReplies.length)).toBe(2);
    await expect(page.locator('bbt-video-controls')).toHaveCount(1);
    await expect(page.locator('.bbt-video-overlay')).toHaveCount(1);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate.cancel').length), 1);
    assert.deepEqual(await page.evaluate(() => [runtimeListeners.length, storageListeners.length]), [1, 1]);
    await page.evaluate(() => document.dispatchEvent(new Event('babata:video-translate-teardown')));
    await expect(page.locator('bbt-video-controls,.bbt-video-overlay')).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => [runtimeListeners.length, storageListeners.length]), [0, 0]);
    assert.equal(await page.evaluate(() => nativeTrack.mode), 'showing');
    assert.equal(await page.evaluate(() => window.__babataVideoTranslateBooted), false);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-bbt-video-translate-version')), false);
    await page.evaluate(() => {
      const clone = video.cloneNode(); video.after(clone);
      video.dispatchEvent(new Event('seeked')); document.dispatchEvent(new Event('visibilitychange'));
      pendingReplies.splice(0).forEach(({ message, resolve }) => resolve(answer(message)));
    });
    await page.waitForTimeout(100);
    await expect(page.locator('bbt-video-controls,.bbt-video-overlay')).toHaveCount(0);
    assert.equal(await page.evaluate(() => requests.filter((m) => m.type === 'babata.translate').length), 2);

    await page.addScriptTag({ content: captureBundle });
    await page.evaluate(() => { window.savedCaptureHooks = [window.fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send]; });
    await page.addScriptTag({ content: captureBundle });
    assert.equal(await page.evaluate(() => savedCaptureHooks.every((fn, at) => fn === [window.fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send][at])), true);
    assert.equal(await page.evaluate(() => window.__babataVideoCaptionCaptureBooted), true);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('legacy video controls require one page refresh instead of stacking another engine', async () => {
    const { page, errors } = await fixture();
    await expect(page.locator('.bbt-video-overlay')).toContainText('译文 Caption number 0.');
    await page.evaluate(() => {
      document.dispatchEvent(new Event('babata:video-translate-teardown'));
      const legacy = document.createElement('bbt-video-controls'); legacy.dataset.bbtVideo = '1'; document.body.append(legacy);
      window.originalFetchBeforeLegacy = window.fetch;
    });
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({ content: captureBundle });
    assert.equal(await page.evaluate(() => window.__babataVideoTranslateBooted), false);
    assert.equal(await page.evaluate(() => window.__babataVideoCaptionCaptureBooted), undefined);
    assert.equal(await page.evaluate(() => originalFetchBeforeLegacy === window.fetch), true);
    await expect(page.locator('bbt-video-controls')).toHaveCount(1);
    await expect(page.locator('.bbt-video-overlay')).toHaveCount(0);
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

  await t.test('global off stops active audio capture, cancels transcription, and on never restarts it', async () => {
    const { page, errors } = await fixture({ realMedia: true, cueCount: 0, transcription: 'hold' });
    await page.evaluate(() => {
      window.clonedTracks = [];
      const clone = MediaStreamTrack.prototype.clone;
      MediaStreamTrack.prototype.clone = function () { const track = clone.call(this); clonedTracks.push(track); return track; };
    });
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByRole('button', { name: '听译（无字幕）', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止听译' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => pendingTranscriptions.length), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const stopped = await page.evaluate(() => {
      setSettings({ 'babata.video_translation_enabled': false });
      const transcriptionIds = new Set(requests.filter((message) => message.type === 'babata.transcribe').map((message) => message.request_id));
      return { cloneStates: clonedTracks.map((track) => track.readyState), sourceStates: originalStream.getAudioTracks().map((track) => track.readyState), cancellations: requests.filter((message) => message.type === 'babata.translate.cancel' && transcriptionIds.has(message.request_id)).length, transcriptions: transcriptionIds.size };
    });
    assert.ok(stopped.cloneStates.length > 0);
    assert.ok(stopped.cloneStates.every((state) => state === 'ended'));
    assert.deepEqual(stopped.sourceStates, ['live']);
    assert.equal(stopped.cancellations, stopped.transcriptions);
    await expect(page.getByRole('button', { name: '听译（无字幕）', exact: true })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('视频翻译已全局关闭');
    await page.evaluate(() => pendingTranscriptions.splice(0).forEach(({ message, resolve }) => resolve(transcriptionAnswer(message))));
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true }));
    await expect(page.getByRole('button', { name: '听译（无字幕）', exact: true })).toBeEnabled();
    await page.waitForTimeout(1400);
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.transcribe').length), stopped.transcriptions);
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.transcribe.capabilities').length), 1);
    assert.equal(await page.evaluate(() => requests.some((message) => message.type === 'babata.translate')), false);
    assert.equal(await page.evaluate(() => video.paused), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('global off cancels a pending ASR start and its late failure cannot stop a later explicit start', async () => {
    const { page, errors } = await fixture({ realMedia: true, cueCount: 0, capabilities: 'hold' });
    await page.evaluate(() => {
      window.clonedTracks = [];
      const clone = MediaStreamTrack.prototype.clone;
      MediaStreamTrack.prototype.clone = function () { const track = clone.call(this); clonedTracks.push(track); return track; };
    });
    await page.getByRole('button', { name: '字幕设置' }).click();
    await page.getByRole('button', { name: '听译（无字幕）', exact: true }).click();
    await expect.poll(() => page.evaluate(() => pendingCapabilities.length)).toBe(1);
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': false }));
    assert.ok(await page.evaluate(() => clonedTracks.length > 0 && clonedTracks.every((track) => track.readyState === 'ended')));
    await page.evaluate(() => setSettings({ 'babata.video_translation_enabled': true }));
    await expect(page.getByRole('button', { name: '听译（无字幕）', exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => requests.filter((message) => message.type === 'babata.transcribe.capabilities').length), 1);
    assert.equal(await page.evaluate(() => requests.some((message) => message.type === 'babata.transcribe')), false);
    await page.evaluate(() => { capabilitiesMode = 'echo'; });
    await page.getByRole('button', { name: '听译（无字幕）', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止听译' })).toBeEnabled();
    await page.evaluate(() => pendingCapabilities.shift().reject(new Error('The cancelled capability lookup failed late.')));
    await page.waitForTimeout(100);
    await expect(page.getByRole('button', { name: '停止听译' })).toBeEnabled();
    assert.equal(await page.evaluate(() => clonedTracks.at(-1).readyState), 'live');
    await expect.poll(() => page.evaluate(() => requests.filter((message) => message.type === 'babata.transcribe').length), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: '停止听译' }).click();
    assert.deepEqual(await page.evaluate(() => originalStream.getAudioTracks().map((track) => track.readyState)), ['live']);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
