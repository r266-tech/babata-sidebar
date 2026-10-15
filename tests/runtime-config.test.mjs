import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/runtime-config.ts'], bundle: true, write: false, format: 'iife', globalName: 'runtimeConfig' });
function runtime(fetchImpl = fetch, values = {}) {
  const context = vm.createContext({
    URL, Headers, AbortController, setTimeout, clearTimeout, fetch: fetchImpl,
    crypto: { randomUUID }, navigator: { locks: { request: async (_key, fn) => fn() } },
    chrome: { runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, storage: {
      session: { get: async (key) => ({ [key]: values[key] }), set: async (input) => Object.assign(values, input) },
      local: { get: async () => values, set: async (input) => Object.assign(values, input) },
    } },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.runtimeConfig;
}

await test('a dispatched mutation is never replayed after an ambiguous transport failure', async () => {
  const calls = [];
  const api = runtime(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/health')) return Response.json({ ok: true });
    throw new TypeError('connection lost after acceptance');
  });
  await assert.rejects(api.serverFetchFromOrigin('http://127.0.0.1:18888', '/cpu', { method: 'POST', body: '{"cpu":"grok"}' }));
  assert.equal(calls.filter(({ init }) => init?.method === 'POST').length, 1);
  assert.ok(calls.every(({ url }) => url.startsWith('http://127.0.0.1:18888')));
});

await test('cancelled requests never dispatch or probe a fallback', async () => {
  let calls = 0;
  const api = runtime(async () => { calls++; return Response.json({ ok: true }); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.serverFetchFromOrigin('http://127.0.0.1:18888', '/chat', { method: 'POST', signal: controller.signal }));
  assert.equal(calls, 0);
});

await test('health timeout covers a body stalled after HTTP headers', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const start = Date.now();
  assert.equal(await runtime().isServerOriginHealthy(`http://127.0.0.1:${server.address().port}`), false);
  assert.ok(Date.now() - start < 3000);
});

await test('fallback selects a reachable server before dispatching the mutation', async () => {
  const calls = [];
  const api = runtime(async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('http://127.0.0.1:18888')) throw new TypeError('offline');
    return Response.json({ ok: true });
  });
  assert.equal((await api.serverFetchFromOrigin('http://127.0.0.1:18888', '/cpu', { method: 'POST' })).ok, true);
  const mutations = calls.filter(({ init }) => init?.method === 'POST');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, 'http://127.0.0.1:18791/cpu');
  assert.match(mutations[0].init.headers.get('x-babata-client-id'), /^[a-f0-9-]{36}$/);
});

await test('cancelling an in-flight health probe stops fallback and preserves settings', async () => {
  const values = { 'babata.server_origin': 'http://127.0.0.1:18888' };
  const calls = [];
  let probing;
  const started = new Promise((resolve) => { probing = resolve; });
  const api = runtime((url, init) => {
    calls.push(url);
    probing();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }, values);
  const controller = new AbortController();
  const request = api.serverFetchFromOrigin(values['babata.server_origin'], '/cpu', { method: 'POST', signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.deepEqual(calls, ['http://127.0.0.1:18888/health']);
  assert.equal(values['babata.server_origin'], 'http://127.0.0.1:18888');
});

await test('a delayed fallback does not overwrite a newer server selection', async () => {
  const values = { 'babata.server_origin': 'http://127.0.0.1:18888' };
  let release;
  let started;
  const probing = new Promise((resolve) => { started = resolve; });
  const api = runtime(async (url) => {
    if (url.startsWith('http://127.0.0.1:18888')) {
      started();
      await new Promise((resolve) => { release = resolve; });
      throw new TypeError('offline');
    }
    return Response.json({ ok: true });
  }, values);
  const resolving = api.resolveReachableServerOrigin('http://127.0.0.1:18888');
  await probing;
  await api.setServerOrigin('http://127.0.0.1:19999');
  release();
  assert.equal(await resolving, 'http://127.0.0.1:18791');
  assert.equal(values['babata.server_origin'], 'http://127.0.0.1:19999');
});

await test('invalid stored routing IDs are repaired before requests are sent', async () => {
  const values = { 'babata.browser_client_id': 'invalid client id' };
  const api = runtime(fetch, values);
  const id = await api.getBrowserClientId();
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(values['babata.browser_client_id'], id);
  assert.equal(await api.getBrowserClientId(), id);
});
