import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/offscreen.ts'], bundle: true, write: false, format: 'iife' });
const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function offscreen(t, { routing, fetchImpl, dispatch, persist } = {}) {
  const sockets = [];
  const records = new Map();
  const timers = new Set();
  let listener;
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    sent = [];
    constructor(url) { super(); this.url = String(url); sockets.push(this); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(payload) { this.sent.push(payload); }
    receive(payload) { this.dispatchEvent(new MessageEvent('message', { data: payload })); }
  }
  const chrome = { runtime: {
    id: extensionId,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: async (message) => {
      if (message.type === 'babata.server_origin.get') {
        return routing ? routing() : { ok: true, origin: 'http://127.0.0.1:18888', client_id: 'test-client' };
      }
      if (message.type === 'babata.chat.snapshot_write') {
        if (persist) await persist(message);
        records.set(message.storage_key, structuredClone(message.record));
        return { ok: true };
      }
      if (message.type === 'babata.chat.snapshot_clear') {
        records.set(message.storage_key, { messages: [], streaming: false });
        return { ok: true };
      }
      return dispatch ? dispatch(message) : { ok: true };
    },
  } };
  const context = vm.createContext({
    chrome, URL, TextDecoder, AbortController, WebSocket: Socket,
    crypto: { randomUUID }, console: { log() {}, warn() {} },
    fetch: fetchImpl || (async () => new Response('data: {"type":"done"}\n\n')),
    window: {
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
      clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
      setInterval: () => 1,
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  return {
    sockets, records,
    message: (message) => new Promise((resolve) => {
      const pending = listener(message, { id: extensionId }, resolve);
      if (pending !== true) resolve(undefined);
    }),
  };
}

await test('an origin switch during routing resolution cannot reopen the old WebSocket', async (t) => {
  let release;
  let reads = 0;
  const host = offscreen(t, { routing: () => {
    reads += 1;
    if (reads === 1) return new Promise((resolve) => { release = resolve; });
    return { ok: true, origin: 'http://127.0.0.1:19999', client_id: 'test-client' };
  } });
  await host.message({ type: 'babata.server_origin.changed', origin: 'http://127.0.0.1:19999' });
  release({ ok: true, origin: 'http://127.0.0.1:18888', client_id: 'test-client' });
  await tick();
  assert.equal(host.sockets.length, 1);
  assert.match(host.sockets[0].url, /^ws:\/\/127\.0\.0\.1:19999\/ws\?/);
});

await test('a delayed dispatch retry from a superseded socket is discarded', async (t) => {
  let inbound = 0;
  const host = offscreen(t, { dispatch: async (message) => {
    if (message.type === 'babata.ws.inbound') {
      inbound += 1;
      throw new Error('service worker restarting');
    }
    return { ok: true };
  } });
  await tick();
  host.sockets[0].receive('{"id":"old-request","method":"browser"}');
  await tick();
  await host.message({ type: 'babata.server_origin.changed', origin: 'http://127.0.0.1:19999' });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(inbound, 1);
});

await test('an incomplete stream is preserved as an error and releases chat ownership', async (t) => {
  const host = offscreen(t, { fetchImpl: async () => new Response('data: null\n\ndata: {"type":"text_delta","text":"partial answer"}\n\n') });
  const key = 'babata.chat.history.v1:window:1';
  const response = await host.message({ type: 'babata.offscreen.chat.start', storage_key: key, message: 'hello', messages: [{ role: 'user', text: 'hello' }] });
  assert.equal(response.ok, true);
  await tick();
  const saved = host.records.get(key);
  assert.equal(saved.streaming, false);
  assert.match(saved.messages.at(-1).text, /partial answer/);
  assert.match(saved.messages.at(-1).text, /stream ended before completion/);
  assert.equal((await host.message({ type: 'babata.offscreen.chat.status', storage_key: key })).streaming, false);
});

await test('clearing an active stream waits for cancellation and leaves an empty snapshot', async (t) => {
  let fetched;
  const started = new Promise((resolve) => { fetched = resolve; });
  const host = offscreen(t, { fetchImpl: async (_url, init) => {
    fetched();
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    } }));
  } });
  const key = 'babata.chat.history.v1:window:1';
  await host.message({ type: 'babata.offscreen.chat.start', storage_key: key, message: 'hello' });
  await started;
  assert.equal((await host.message({ type: 'babata.offscreen.chat.clear', storage_key: key })).ok, true);
  await tick();
  assert.deepEqual(host.records.get(key), { messages: [], streaming: false });
  assert.equal((await host.message({ type: 'babata.offscreen.chat.status', storage_key: key })).streaming, false);
});

await test('a failed final persistence keeps the answer visible and reports it as unsaved', async (t) => {
  const failures = [];
  const host = offscreen(t, {
    fetchImpl: async () => new Response('data: {"type":"text_delta","text":"answer retained in memory"}\n\ndata: {"type":"done"}\n\n'),
    persist: (message) => { if (!message.record.streaming) throw new Error('disk write unavailable'); },
    dispatch: async (message) => { if (message.type === 'babata.chat.snapshot_error') failures.push(message); return { ok: true }; },
  });
  const key = 'babata.chat.history.v1:window:1';
  const turnId = 'persistence-turn';
  await host.message({ type: 'babata.offscreen.chat.start', storage_key: key, turn_id: turnId, message: 'hello' });
  await tick();
  assert.ok(failures.length > 0);
  assert.equal(failures.at(-1).turn_id, turnId);
  assert.equal(failures.at(-1).streaming, false);
  assert.equal(failures.at(-1).messages.at(-1).text, 'answer retained in memory');
  assert.match(failures.at(-1).error, /disk write unavailable/);
  assert.equal((await host.message({ type: 'babata.offscreen.chat.status', storage_key: key })).streaming, false);
});
