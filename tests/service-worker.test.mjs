import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const source = await readFile('src/service-worker.ts', 'utf8');
const bundle = await build({ stdin: { contents: source + '\nexport { ensureOffscreen, actPageClickRef, snapshotStores, actBookmarksSearch, actBookmarksTree, actHistorySearch, requestCleanRead, sendToWs };', resolveDir: 'src', loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'sw' });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function host({ createDocument = async () => {}, fetchImpl = async () => new Response('{}'), executeScript } = {}) {
  const data = {};
  const sent = [];
  const events = {};
  const event = (name) => ({ addListener: (callback) => { events[name] = callback; } });
  const store = {
    async get(keys) {
      await tick();
      return Object.fromEntries((typeof keys === 'string' ? [keys] : keys || Object.keys(data)).map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) { await tick(); Object.assign(data, structuredClone(values)); },
  };
  const tab = { id: 1, windowId: 10, active: true, url: 'https://article.test/one', title: 'Article' };
  let scripts = [];
  const chrome = {
    runtime: { id, getURL: (path) => `chrome-extension://${id}/${path}`, getContexts: async () => [], onConnect: event('connect'), onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async (message) => { sent.push(message); return {}; } },
    offscreen: { hasDocument: async () => false, Reason: { WORKERS: 'WORKERS' }, createDocument },
    storage: { local: store, session: store, onChanged: event('storage') },
    tabs: { query: async () => [tab], get: async () => ({ ...tab }), sendMessage: async (...args) => { sent.push(args); }, onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed') },
    sidePanel: { setOptions: async () => {}, open: async () => {}, setPanelBehavior: async () => {} },
    commands: { onCommand: event('command') },
    scripting: { executeScript: async (spec) => { scripts.push(spec); return executeScript ? executeScript(spec) : [{ documentId: 'document-1', result: {} }]; } },
    bookmarks: { getTree: async () => [{ id: 'root', children: Array.from({ length: 3000 }, (_, i) => ({ id: String(i), title: 'Folder' })) }], search: async () => Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })) },
    history: { search: async (query) => { sent.push(query); return []; } },
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID }, navigator: { locks: { request: async (_name, operation) => operation() } }, console: { debug() {}, warn() {} }, URL, URLSearchParams, Headers, TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: fetchImpl });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return { api: context.sw, data, events, sent, tab, scripts, message: (message, sender = { id, url: `chrome-extension://${id}/src/sidepanel.html` }) => new Promise((resolve) => {
    const pending = events.message(message, sender, resolve);
    if (pending !== true) resolve(undefined);
  }) };
}

await test('concurrent snapshot CAS updates reject stale panels and stale stop requests', async () => {
  const h = host();
  const key = 'babata.chat.history.v1:window:10';
  const first = await h.message({ type: 'babata.chat.snapshot_write', storage_key: key, record: { version: 1, messages: [{ text: 'first' }], active_turn_id: 'turn-one', streaming: true } });
  const expected = { expected_updated_at: first.record.updated_at, expected_turn_id: 'turn-one' };
  const [newer, stale] = await Promise.all([
    h.message({ type: 'babata.chat.snapshot_write', storage_key: key, ...expected, record: { version: 1, messages: [{ text: 'new turn' }], active_turn_id: 'turn-two', streaming: true } }),
    h.message({ type: 'babata.chat.snapshot_mark_stopped', storage_key: key, ...expected }),
  ]);
  assert.equal(newer.changed, true);
  assert.equal(stale.changed, false);
  assert.equal(h.data[key].active_turn_id, 'turn-two');
  assert.equal(h.data[key].streaming, true);
  assert.ok(h.data[key].updated_at > first.record.updated_at);
  await h.message({ type: 'babata.chat.snapshot_clear', storage_key: key });
  const afterClear = await h.message({ type: 'babata.chat.snapshot_write', storage_key: key, expected_updated_at: newer.record.updated_at, record: first.record });
  assert.equal(afterClear.changed, false);
  assert.equal(h.data[key].messages.length, 0);
});

await test('host translation updates serialize and derive host from the sending document', async () => {
  const h = host();
  const sender = (host) => ({ id, url: `https://${host}/frame`, tab: { id: 1, url: 'https://top.test/' } });
  const results = await Promise.all(['one.test', 'two.test'].map((host) => h.message({ type: 'babata.set_host_translation', enabled: false, host: 'forged.test' }, sender(host))));
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(h.data['babata.translation_always_disabled_hosts'].sort(), ['one.test', 'two.test']);
});

await test('offscreen creation is single flight and creation errors reach callers', async () => {
  let release;
  let calls = 0;
  const h = host({ createDocument: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  const pending = [h.api.ensureOffscreen(), h.api.ensureOffscreen()];
  await tick();
  assert.equal(calls, 1);
  release();
  await Promise.all(pending);
  const failure = host({ createDocument: async () => { throw new Error('unavailable'); } });
  const response = await failure.message({ type: 'babata.chat.status', storage_key: 'babata.chat.history.v1:window:1' });
  assert.equal(response.ok, false);
  assert.match(response.error, /unavailable/);
});

await test('snapshot references expire at use and stay bound to the original document', async () => {
  const h = host();
  h.api.snapshotStores.set('old', { tabId: 1, url: h.tab.url, createdAt: Date.now() - 700_000, selectors: { e1: '#button' }, documentId: 'document-old' });
  await assert.rejects(h.api.actPageClickRef({ snapshot_id: 'old', ref: 'e1' }), /expired/);
  h.api.snapshotStores.set('new', { tabId: 1, url: h.tab.url, createdAt: Date.now(), selectors: { e1: '#button' }, documentId: 'document-new' });
  await h.api.actPageClickRef({ snapshot_id: 'new', ref: 'e1' });
  assert.equal(h.scripts.at(-1).target.documentIds[0], 'document-new');
});

await test('browser result limits and malformed inbound messages are bounded', async () => {
  const h = host();
  assert.equal((await h.api.actBookmarksSearch({ max_results: -1 })).length, 1);
  const folders = await h.api.actBookmarksTree();
  assert.equal(folders[0].children.length, 1999);
  assert.equal(folders[0].truncated, true);
  h.api.sendToWs({ kind: 'response', id: 'large', ok: true, result: '文'.repeat(2_000_000) });
  assert.equal(JSON.parse(h.sent.at(-1).payload).ok, false);
  assert.match(JSON.parse(h.sent.at(-1).payload).error, /4 MiB/);
  assert.equal((await h.api.actBookmarksSearch({ max_results: 1e9 })).length, 500);
  await h.api.actHistorySearch({ max_results: 1e9 });
  assert.equal(h.sent.at(-1).maxResults, 500);
  await assert.rejects(h.api.actHistorySearch({ start_ms: NaN }), /invalid time/);
  assert.equal((await h.message({ type: 'babata.ws.inbound', payload: 'null' })).ok, true);
  await h.message({ type: 'babata.ws.inbound', payload: '{"kind":"request","id":"invalid","action":"dom_query","args":42}' });
  assert.equal(JSON.parse(h.sent.at(-1).payload).ok, false);
});

await test('navigation cancels clean-read and prevents the old result from reaching a new page', async () => {
  let started;
  const fetched = new Promise((resolve) => { started = resolve; });
  let signal;
  const h = host({
    executeScript: async () => [{ documentId: 'document-1', result: { url: 'https://article.test/one', text: 'article '.repeat(100), char_count: 800 } }],
    fetchImpl: async (_url, init) => { signal = init.signal; started(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); },
  });
  const result = h.api.requestCleanRead(1);
  await fetched;
  h.tab.url = 'https://article.test/two';
  h.events.updated(1, { status: 'loading', url: h.tab.url }, h.tab);
  assert.equal(await result, false);
  assert.equal(signal.aborted, true);
  assert.equal(h.sent.filter((message) => message?.action === 'clean_read_result' || message?.action === 'clean_read_error').length, 0);
});
