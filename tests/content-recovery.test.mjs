import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = (await build({ entryPoints: ['src/content-recovery.ts'], bundle: true, write: false, format: 'iife', globalName: 'recovery' })).outputFiles[0].text;
const context = vm.createContext({});
vm.runInContext(bundle, context);
const { createTranslationContentRecovery, translationContentFiles, recoveryContentFiles } = context.recovery;
const loader = 'assets/babata-translate.ts-loader-fixture.js';
const videoLoader = 'assets/youtube-subtitles.ts-loader-fixture.js';
const mainLoader = 'assets/youtube-subtitles-main.ts-fixture.js';
const manifest = { content_scripts: [
  { js: [videoLoader], all_frames: true },
  { js: [mainLoader], all_frames: true, world: 'MAIN' },
  { js: ['assets/babata-widget.ts-loader-fixture.js'] },
  { js: [loader], all_frames: true, match_about_blank: true },
] };
const pageManifest = { content_scripts: [{ js: [loader] }] };
const state = (overrides = {}) => ({ page: false, video: false, legacyVideo: false, ...overrides });
const normalTab = { id: 7, url: 'https://example.test/thread', active: true, discarded: false };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function host({ tabs = [normalTab], currentManifest = pageManifest, probe, inject, getTab } = {}) {
  const calls = [];
  const queried = [];
  const api = {
    runtime: { getManifest: () => currentManifest },
    tabs: {
      get: async (id) => getTab ? getTab(id) : tabs.find((tab) => tab.id === id),
      query: async (query) => { queried.push(query); return tabs; },
    },
    scripting: { executeScript: async (spec) => {
      calls.push(spec);
      if (spec.func) return probe ? probe(spec) : [{ frameId: 0, documentId: spec.target.documentIds?.[0] ?? 'document-main', result: spec.world === 'MAIN' ? false : state() }];
      return inject ? inject(spec) : [];
    } },
  };
  return { ...createTranslationContentRecovery(api), calls, queried };
}

await test('recovery resolves only the translation entry from source and built manifests', () => {
  assert.deepEqual(Array.from(translationContentFiles(manifest)), [loader]);
  assert.deepEqual(Array.from(translationContentFiles({ content_scripts: [{ js: ['src/content/babata-translate.ts'] }] })), ['src/content/babata-translate.ts']);
  assert.deepEqual(Array.from(translationContentFiles({ content_scripts: [{ js: [loader], world: 'MAIN' }] })), []);
  assert.deepEqual(Array.from(translationContentFiles({})), []);
  assert.deepEqual(JSON.parse(JSON.stringify(recoveryContentFiles(manifest))), { page: [loader], video: [videoLoader], main: [mainLoader] });
  assert.deepEqual(JSON.parse(JSON.stringify(recoveryContentFiles({ content_scripts: [
    { js: ['src/content/babata-translate.ts', 'src/content/youtube-subtitles.ts'] },
    { js: ['src/content/youtube-subtitles-main.ts'], world: 'MAIN' },
    { js: [videoLoader], world: 'MAIN' },
    { js: [mainLoader] },
  ] }))), { page: ['src/content/babata-translate.ts'], video: ['src/content/youtube-subtitles.ts'], main: ['src/content/youtube-subtitles-main.ts'] });
});

await test('recovery probes isolated state and injects only missing documents', async () => {
  const h = host({ probe: (spec) => {
    assert.equal(spec.world, 'ISOLATED');
    assert.equal(spec.target.allFrames, true);
    const runProbe = (window, ownedVideoDom = false, version = null) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${spec.func.toString()})()`, {
      window, document: { querySelector: () => ownedVideoDom ? {} : null, documentElement: { getAttribute: () => version } },
    })));
    assert.deepEqual(runProbe({ __babataTranslateBooted: true, __babataVideoTranslateBooted: true }), state({ page: true, video: true }));
    assert.deepEqual(runProbe({}), state(), 'a stale DOM mode attribute is not a health signal');
    assert.equal(runProbe({}, true).legacyVideo, true);
    assert.equal(runProbe({}, true, '2').legacyVideo, false, 'new controllers support cross-context teardown');
    return [
      { frameId: 0, documentId: 'running-main', result: state({ page: true }) },
      { frameId: 1, documentId: 'missing-child', result: state() },
      { frameId: 2, documentId: 'missing-child', result: state() },
      { frameId: 3, result: state() },
      { frameId: 4, documentId: 'failed-probe' },
    ];
  } });
  await h.recoverTab(7);
  assert.equal(h.calls.length, 2);
  const injection = h.calls[1];
  assert.equal(injection.world, 'ISOLATED');
  assert.deepEqual(Array.from(injection.files), [loader]);
  assert.deepEqual(Array.from(injection.target.documentIds), ['missing-child']);
  assert.equal(injection.target.frameIds, undefined);
  assert.equal(injection.target.allFrames, undefined);
});

await test('healthy engines are left running without reinjection', async () => {
  const h = host({ probe: () => [{ documentId: 'running', result: state({ page: true, video: true }) }] });
  await h.recoverTab(7);
  assert.equal(h.calls.length, 1);
});

await test('page, video and MAIN capture recover independently in their original documents and worlds', async () => {
  const h = host({ currentManifest: manifest, probe: (spec) => {
    if (spec.world === 'MAIN') {
      assert.equal(spec.target.allFrames, undefined);
      const run = (window) => vm.runInNewContext(`(${spec.func.toString()})()`, { window });
      assert.equal(run({ __babataVideoCaptionCaptureBooted: true }), true);
      assert.equal(run({}), false);
      const documentId = spec.target.documentIds[0];
      return [{ documentId, result: !['missing-video', 'missing-capture'].includes(documentId) }];
    }
    return [
      { documentId: 'healthy', result: state({ page: true, video: true }) },
      { documentId: 'missing-page', result: state({ video: true }) },
      { documentId: 'missing-video', result: state({ page: true }) },
      { documentId: 'missing-capture', result: state({ page: true, video: true }) },
    ];
  } });
  const report = await h.recoverTab(7);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), { tabId: 7, injected: { page: 1, video: 1, main: 2 }, needs_refresh: [] });
  const injected = h.calls.filter((call) => call.files).map((call) => ({ document: call.target.documentIds[0], world: call.world, files: Array.from(call.files) }));
  assert.deepEqual(injected.filter((item) => item.files.includes(loader)), [{ document: 'missing-page', world: 'ISOLATED', files: [loader] }]);
  assert.deepEqual(injected.filter((item) => item.files.includes(videoLoader)), [{ document: 'missing-video', world: 'ISOLATED', files: [videoLoader] }]);
  assert.deepEqual(injected.filter((item) => item.files.includes(mainLoader)).map((item) => [item.document, item.world]).sort(), [['missing-capture', 'MAIN'], ['missing-video', 'MAIN']]);
});

await test('legacy video controllers require one refresh while page text and safe sibling frames still recover', async () => {
  const h = host({ currentManifest: manifest, probe: (spec) => spec.world === 'MAIN'
    ? [{ documentId: spec.target.documentIds[0], result: false }]
    : [
      { documentId: 'legacy-video', result: state({ legacyVideo: true }) },
      { documentId: 'safe-child', result: state() },
    ] });
  const report = await h.recoverTab(7);
  assert.deepEqual(JSON.parse(JSON.stringify(report.needs_refresh)), [{ documentId: 'legacy-video', reason: 'legacy_video_context' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(report.injected)), { page: 2, video: 1, main: 1 });
  const legacyCalls = h.calls.filter((call) => call.target.documentIds?.[0] === 'legacy-video');
  assert.equal(legacyCalls.length, 1);
  assert.deepEqual(Array.from(legacyCalls[0].files), [loader]);
  assert.equal(legacyCalls[0].world, 'ISOLATED', 'neither a second video controller nor another MAIN hook is installed');
});

await test('current-version stale DOM can recover and a surviving MAIN hook is not stacked', async () => {
  const h = host({ currentManifest: manifest, probe: (spec) => spec.world === 'MAIN'
    ? [{ documentId: 'reload-document', result: true }]
    : [{ documentId: 'reload-document', result: state() }] });
  const report = await h.recoverTab(7);
  assert.deepEqual(JSON.parse(JSON.stringify(report.injected)), { page: 1, video: 1, main: 0 });
  assert.equal(report.needs_refresh.length, 0);
});

await test('MAIN probe errors or a replacement document never redirect injection or block isolated recovery', async () => {
  const h = host({ currentManifest: manifest, probe: (spec) => {
    if (spec.world !== 'MAIN') return [{ documentId: 'restricted', result: state() }, { documentId: 'navigated', result: state() }];
    if (spec.target.documentIds[0] === 'restricted') throw new Error('Cannot access MAIN world');
    return [{ documentId: 'replacement', result: false }];
  } });
  const report = await h.recoverTab(7);
  assert.deepEqual(JSON.parse(JSON.stringify(report.injected)), { page: 2, video: 2, main: 0 });
  assert.equal(h.calls.some((call) => call.files?.includes(mainLoader)), false);
  assert.equal(h.calls.some((call) => call.target.documentIds?.includes('replacement')), false);
});

await test('simultaneous installation and activation share one recovery and release the flight', async () => {
  const gate = deferred();
  let probes = 0;
  const h = host({ probe: async () => { probes++; await gate.promise; return [{ documentId: 'main', result: state() }]; } });
  const first = h.recoverTab(7);
  const second = h.recoverTab(7);
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.equal(h.calls.filter((call) => call.files).length, 1);
  await h.recoverTab(7);
  assert.equal(probes, 2, 'a later activation must be able to check the current document');
});

await test('navigation and inaccessible-frame failures cannot inject into replacement documents or stop siblings', async () => {
  const h = host({
    probe: () => [{ documentId: 'navigated-away', result: state() }, { documentId: 'live-child', result: state() }],
    inject: async (spec) => { if (spec.target.documentIds[0] === 'navigated-away') throw new Error('No document with this id'); },
  });
  await h.recoverTab(7);
  assert.deepEqual(h.calls.filter((call) => call.files).map((call) => Array.from(call.target.documentIds)), [['navigated-away'], ['live-child']]);
  assert.equal(h.calls.some((call) => call.files && !call.target.documentIds), false);
});

await test('startup excludes discarded and non-web tabs and handles per-tab failures', async () => {
  const tabs = [normalTab, { id: 8, url: 'http://example.test/other' },
    { id: 9, url: 'https://example.test/discarded', discarded: true },
    { id: 10, url: 'chrome://settings/' }, { id: 11, url: 'file:///fixture.html' },
    { id: 12, url: 'https://example.test/closed' }];
  const h = host({ tabs, getTab: async (id) => { if (id === 12) throw new Error('Tab closed'); return tabs.find((tab) => tab.id === id); } });
  await h.recoverExistingTabs();
  assert.deepEqual(h.calls.filter((call) => call.func).map((call) => call.target.tabId).sort(), [7, 8]);
  assert.deepEqual(Array.from(h.queried[0].url), ['http://*/*', 'https://*/*']);
  await Promise.all([9, 10, 11, 12].map((id) => h.recoverTab(id)));
  assert.equal(h.calls.length, 4);
});

await test('startup bounds simultaneous tab recovery while prioritizing active tabs', async () => {
  const tabs = Array.from({ length: 10 }, (_, id) => ({ id, url: `https://example.test/${id}`, active: id === 9 }));
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const order = [];
  const h = host({ tabs, probe: async (spec) => {
    active++; maximum = Math.max(maximum, active); order.push(spec.target.tabId);
    await gate.promise; active--;
    return [{ documentId: String(spec.target.tabId), result: state({ page: true }) }];
  } });
  const pending = h.recoverExistingTabs();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 4);
  assert.equal(order[0], 9);
  gate.resolve();
  await pending;
  assert.equal(order.length, 10);
  assert.equal(maximum, 4);
});

await test('missing manifest entries and protected page errors are harmless and retryable', async () => {
  const missing = host({ currentManifest: {} });
  await missing.recoverTab(7);
  assert.equal(missing.calls.length, 0);
  let failures = 0;
  const protectedPage = host({ probe: () => { failures++; throw new Error('Cannot access this page'); } });
  await protectedPage.recoverTab(7);
  await protectedPage.recoverTab(7);
  assert.equal(failures, 2);
});
