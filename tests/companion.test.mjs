import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startCompanion, extensionOrigin } from './companion-fixture.mjs';

async function until(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail('condition did not become true');
}

function events(raw) {
  return raw.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
}

async function browser(server, client) {
  const ws = new WebSocket(`${server.origin.replace('http:', 'ws:')}/ws?client_id=${client}`, { origin: extensionOrigin });
  await once(ws, 'open');
  return ws;
}

await test('isolated companion regressions', async (t) => {
  const server = await startCompanion({ OPENAI_API_KEY: 'test-env-key', BABATA_TRANSLATION_MODEL: 'test-env-model' });
  t.after(() => server.close());

  await t.test('environment defaults apply without a config; explicit clears persist', async () => {
    const initial = await (await server.request('/settings')).json();
    assert.equal(initial.translation_provider.api_key, 'test-env-key');
    assert.equal(initial.translation_provider.model, 'test-env-model');
    const saved = await (await server.post('/settings', { translation_provider: { api_key: '', model: '' } })).json();
    assert.equal(saved.translation_provider.api_key_set, false);
    assert.equal((await (await server.request('/settings')).json()).translation_provider.model, '');
    if (process.platform !== 'win32') assert.equal((await stat(server.configPath)).mode & 0o777, 0o600);
  });

  await t.test('IPv6 loopback accepts HTTP and WebSocket requests', async (t) => {
    let ipv6;
    try { ipv6 = await startCompanion({ BABATA_SIDEBAR_HOST: '::1' }); }
    catch (err) {
      if (/EAFNOSUPPORT|EADDRNOTAVAIL/.test(err.message)) { t.skip('IPv6 loopback is not available'); return; }
      throw err;
    }
    t.after(() => ipv6.close());
    assert.equal((await ipv6.request('/health')).status, 200);
    const socket = await browser(ipv6, 'ipv6-browser');
    socket.terminate();
  });

  await t.test('invalid JSON shapes and origins are rejected; health never exposes keys', async () => {
    for (const body of ['null', '[]', '3', '{']) {
      assert.equal((await server.request('/settings', { method: 'POST', body })).status, 400);
    }
    const before = await readFile(server.configPath, 'utf8');
    for (const translation_provider of [[], null, 'invalid', { api_key: null }, { model: 3 }]) {
      assert.equal((await server.post('/settings', { translation_provider })).status, 400);
      assert.equal(await readFile(server.configPath, 'utf8'), before);
    }
    assert.equal((await fetch(`${server.origin}/settings`)).status, 403);
    assert.equal((await server.request('/settings', { headers: { origin: 'https://example.test' } })).status, 403);
    assert.equal((await server.request('/settings', { headers: { origin: 'chrome-extension://id/path' } })).status, 403);
    const extensionHeaders = { 'x-babata-extension-origin': extensionOrigin };
    assert.equal((await fetch(`${server.origin}/settings`, { headers: extensionHeaders })).status, 200);
    assert.equal((await fetch(`${server.origin}/settings`, { headers: { ...extensionHeaders, origin: 'https://example.test' } })).status, 403);
    assert.equal((await fetch(`${server.origin}/settings`, { headers: { 'x-babata-extension-origin': 'https://example.test' } })).status, 403);
    assert.equal((await server.post('/history', {})).status, 404);
    await server.post('/settings', { translation_provider: { api_key: 'test-saved-key' } });
    const health = await server.request('/health');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.ok(!(await health.text()).includes('test-saved-key'));
  });

  await t.test('oversized request bodies return a readable HTTP error', async () => {
    const response = await server.request('/translate', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(17 * 1024 * 1024) }) });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/);
    assert.equal((await server.request('/health')).status, 200);
  });

  await t.test('concurrent settings edits preserve a CPU switch made while the body arrives', async () => {
    let finishBody;
    const response = new Promise((resolve, reject) => {
      const req = http.request(`${server.origin}/settings`, { method: 'POST', headers: { origin: extensionOrigin, 'content-type': 'application/json' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write('{"translation_provider":');
      finishBody = () => req.end('{"model":"parallel-model"}}');
    });
    await delay(40);
    assert.equal((await server.post('/cpu', { cpu: 'grok' })).status, 200);
    finishBody();
    assert.equal(await response, 200);
    const config = await (await server.request('/settings')).json();
    assert.equal(config.cpu, 'grok');
    assert.equal(config.translation_provider.model, 'parallel-model');
  });

  await t.test('explicit CPU wins over global default; history is scoped to browser and conversation', async () => {
    for (const cpu of ['codex', 'claude', 'grok']) {
      const response = await server.post('/chat', { cpu, message: 'hello', conversation_id: 'chat-one', debug_prompt: true, page_context: { url: 'https://example.test/article', title: 'Article', selection: 'SELECTED' } });
      const stream = events(await response.text());
      assert.ok(stream.some((event) => event.type === 'text_delta' && event.text === `${cpu} fake reply`));
      assert.ok(stream.some((event) => event.type === 'debug_prompt' && event.cpu === cpu && event.prompt.includes('SELECTED')));
      assert.equal(stream.at(-1).type, 'done');
    }
    const history = await (await server.request('/history?conversation_id=chat-one')).json();
    assert.equal(history.turns.length, 6);
    assert.equal((await (await server.request('/history?conversation_id=chat-two')).json()).turns.length, 0);
    assert.equal((await (await server.request('/history?conversation_id=chat-one', { client: 'browser-b' })).json()).turns.length, 0);
    const context = await server.post('/chat', { message: 'what token?', messages: [{ role: 'user', text: 'SMOKE_HISTORY_TOKEN' }] });
    assert.match(await context.text(), /SMOKE_HISTORY_TOKEN/);
  });

  await t.test('browser tools and notifications reach the requesting client; replies are socket-bound', async () => {
    const a = await browser(server, 'browser-a');
    const b = await browser(server, 'browser-b');
    t.after(() => { a.terminate(); b.terminate(); });
    let receivedA = 0;
    a.on('message', () => { receivedA += 1; });
    b.on('message', async (raw) => {
      const request = JSON.parse(raw);
      if (request.kind !== 'request') return;
      assert.equal(request.args.tab_id, 42);
      a.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: 'FORGED_RESULT' }));
      await delay(30);
      // Fragmentation and ping/pong are handled by the actual WS implementation.
      const reply = JSON.stringify({ kind: 'response', id: request.id, ok: true, result: 'RESULT_FROM_B' });
      b.send(reply.slice(0, 20), { fin: false });
      b.send(reply.slice(20), { fin: true });
    });
    const chat = await server.post('/chat', { cpu: 'codex', message: 'USE_BROWSER_TOOL', page_context: { tab_id: 42 } }, { client: 'browser-b' });
    const text = await chat.text();
    assert.match(text, /RESULT_FROM_B/);
    assert.doesNotMatch(text, /FORGED_RESULT/);
    const notification = once(b, 'message');
    await server.post('/proactive', { intent: 'prompt_suggestions' }, { client: 'browser-b' });
    assert.equal(JSON.parse((await notification)[0]).action, 'suggest_prompts');
    assert.equal(receivedA, 0);
    a.terminate(); b.terminate();
  });

  await t.test('long multi-turn prompts avoid platform argument limits and clean up temporary files', async () => {
    const messages = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '上下文'.repeat(2666) }));
    for (const cpu of ['codex', 'claude', 'grok']) {
      const response = await server.post('/chat', { cpu, message: 'hello', messages });
      assert.match(await response.text(), new RegExp(`${cpu} fake reply`));
      const invocation = JSON.parse(await readFile(server.invocationFile, 'utf8'));
      assert.ok(invocation.promptChars > 180000);
      assert.ok(invocation.argChars < 2000);
      if (invocation.promptFile) await assert.rejects(stat(invocation.promptFile), { code: 'ENOENT' });
    }
  });

  await t.test('model input keeps a bounded recent conversation and bounded attachment metadata', async () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `TURN_${i}_MARKER` }));
    const attachments = Array.from({ length: 80 }, (_, i) => ({ name: `FILE_${i}_MARKER`, mime: 'text/plain', size: 1 }));
    const stream = events(await (await server.post('/chat', { cpu: 'codex', message: 'latest', messages, attachments, debug_prompt: true })).text());
    const prompt = stream.find((event) => event.type === 'debug_prompt').prompt;
    assert.doesNotMatch(prompt, /TURN_76_MARKER/);
    assert.match(prompt, /TURN_77_MARKER/);
    assert.match(prompt, /TURN_99_MARKER/);
    assert.match(prompt, /FILE_63_MARKER/);
    assert.doesNotMatch(prompt, /FILE_64_MARKER/);
  });

  await t.test('clean read returns the result without requiring a browser socket', async () => {
    await server.post('/settings', { translation_provider: { model: '' } });
    const response = await server.post('/clean_read', { title: 'Test article', article: { text: 'A useful original paragraph.' }, tab_id: 42, run_id: 'reader-run' });
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.result.run_id, 'reader-run');
    assert.equal(result.result.tab_id, 42);
    assert.match(result.result.markdown, /A useful original paragraph/);
  });

  await t.test('aborting the HTTP stream kills the CLI and its descendants', async () => {
    const controller = new AbortController();
    const response = await server.post('/chat', { cpu: 'codex', message: 'SLOW_TEST', conversation_id: 'cancelled' }, { signal: controller.signal });
    await until(async () => { try { return JSON.parse(await readFile(server.pidFile)).length === 2; } catch { return false; } });
    const pids = JSON.parse(await readFile(server.pidFile));
    controller.abort();
    await response.text().catch(() => {});
    await until(() => pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    assert.deepEqual((await (await server.request('/history?conversation_id=cancelled')).json()).turns, []);
  });

  await t.test('CLI helpers cannot outlive a successful parent or companion shutdown', { skip: process.platform === 'win32' }, async () => {
    assert.match(await (await server.post('/chat', { cpu: 'codex', message: 'EXIT_HELPER_TEST' })).text(), /codex fake reply/);
    const completedPids = JSON.parse(await readFile(server.pidFile));
    const gone = (pids) => pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await until(() => gone(completedPids));

    const shutdownServer = await startCompanion();
    t.after(() => shutdownServer.close());
    const response = await shutdownServer.post('/chat', { cpu: 'codex', message: 'SLOW_TEST EXIT_PARENT_ON_STOP' });
    const consumed = response.text().catch(() => {});
    await until(async () => { try { return JSON.parse(await readFile(shutdownServer.pidFile)).length === 2; } catch { return false; } });
    const pids = JSON.parse(await readFile(shutdownServer.pidFile));
    await delay(100);
    await shutdownServer.close();
    await consumed;
    await until(() => gone(pids));
  });

  await t.test('provider URL normalization, stalled bodies, and destination changes', async () => {
    const requests = [];
    const provider = http.createServer(async (req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      if (req.url.startsWith('/slow/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/oversized/')) { res.setHeader('content-length', 17 * 1024 * 1024); res.flushHeaders(); return; }
      if (req.url.startsWith('/chunked-large/')) { res.write('x'.repeat(17 * 1024 * 1024)); res.end(); return; }
      if (req.url.startsWith('/bad-json/')) { res.writeHead(502); res.end('<html>upstream failed</html>'); return; }
      if (req.url.endsWith('/models')) res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      else {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const input = JSON.parse(request.messages.at(-1).content);
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: input.batch.map((item) => ({ hash: item.hash, translated: `你好 ${item.text}` })) }) } }] }));
      }
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(() => { provider.closeAllConnections(); provider.close(); });
    const base = `http://127.0.0.1:${provider.address().port}`;
    const models = await server.post('/translate/models', { base_url: `${base}/v1/chat/completions` });
    assert.equal(models.status, 200);
    assert.equal(requests.at(-1).url, '/v1/models');
    assert.equal(requests.at(-1).auth, undefined, 'saved key must not follow a new provider destination');
    const test = await server.post('/translate/test', { base_url: `${base}/v1`, model: 'local-model', api_key: '' });
    assert.equal(test.status, 200, 'keyless local providers work');
    const started = Date.now();
    const stalled = await server.post('/translate/models', { base_url: `${base}/slow/v1` });
    assert.equal(stalled.status, 504);
    assert.ok(Date.now() - started < 2000);
    for (const route of ['oversized', 'chunked-large', 'bad-json']) {
      const response = await server.post('/translate/models', { base_url: `${base}/${route}/v1` });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /response exceeded limit|non-JSON data/);
    }
  });

  await t.test('provider concurrency is bounded and disconnect aborts the upstream request', async () => {
    const bounded = await startCompanion({ BABATA_PROVIDER_TIMEOUT_MS: '4000', BABATA_PROVIDER_MAX_CONCURRENT: '2', BABATA_PROVIDER_MAX_RETRIES: '0' });
    t.after(() => bounded.close());
    let opened = 0;
    let closed = 0;
    const provider = http.createServer((req, res) => {
      opened += 1;
      res.on('close', () => { closed += 1; });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(() => { provider.closeAllConnections(); provider.close(); });
    const body = { base_url: `http://127.0.0.1:${provider.address().port}/v1` };
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const calls = controllers.slice(0, 2).map((controller) => bounded.post('/translate/models', body, { signal: controller.signal }).catch(() => {}));
    await until(() => opened === 2);
    calls.push(bounded.post('/translate/models', body, { signal: controllers[2].signal }).catch(() => {}));
    await delay(60);
    assert.equal(opened, 2, 'excess work waits instead of consuming another provider slot');
    controllers[0].abort();
    await until(() => opened === 3);
    controllers.forEach((controller) => controller.abort());
    await Promise.all(calls);
    await until(() => closed === 3, 1500);
    const controller = new AbortController();
    const retry = bounded.post('/translate/models', body, { signal: controller.signal }).catch(() => {});
    await until(() => opened === 4);
    controller.abort();
    await retry;
    await until(() => closed === 4, 1500);
  });

  await t.test('a malformed saved provider URL can be repaired without forwarding its key', async () => {
    await writeFile(server.configPath, JSON.stringify({ cpu: 'codex', translation_provider: { base_url: 'not a URL', api_key: 'old-private-key', model: 'test-model' } }));
    const response = await server.post('/settings', { translation_provider: { base_url: 'https://example.test/v1' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).translation_provider.api_key_set, false);
  });

  await t.test('syntactically or structurally corrupt configuration is reported and preserved', async () => {
    for (const source of ['{invalid', 'null', '[]', '3', '{"cpu":"unknown"}', '{"translation_provider":[]}', '{"translation_provider":{"api_key":false}}']) {
      await writeFile(server.configPath, source);
      assert.equal((await server.post('/cpu', { cpu: 'codex' })).status, 500);
      assert.equal(await readFile(server.configPath, 'utf8'), source);
    }
  });
});
