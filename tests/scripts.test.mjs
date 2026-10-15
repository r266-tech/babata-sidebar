import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { connectCdp, fetchJson, evaluateCdp } from "../scripts/manual-smoke-cdp.mjs";
import { commandExists, companionOrigin, companionHealth } from "../scripts/setup-local.mjs";

await test("setup helpers detect executable files and honor the configured companion address", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "babata-scripts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "directory-cli"));
  const file = path.join(dir, process.platform === "win32" ? "test-cli.cmd" : "test-cli");
  await writeFile(file, "test", { mode: 0o700 });
  assert.equal(await commandExists(file), true);
  assert.equal(await commandExists(path.join(dir, "directory-cli")), false);
  assert.equal(await commandExists("directory-cli", { PATH: dir }), false);
  assert.equal(await commandExists("test-cli", { PATH: dir, PATHEXT: ".CMD" }), true);
  assert.equal(companionOrigin({}), "http://127.0.0.1:18791");
  assert.equal(companionOrigin({ PORT: "19222" }), "http://127.0.0.1:19222");
  assert.equal(companionOrigin({ PORT: "19222", BABATA_SIDEBAR_PORT: "19223", BABATA_SIDEBAR_HOST: "0.0.0.0" }), "http://127.0.0.1:19223");
  assert.equal(companionOrigin({ BABATA_SIDEBAR_HOST: "::1" }), "http://[::1]:18791");
  assert.equal(companionOrigin({ BABATA_SIDEBAR_PORT: "0" }), null);
  assert.throws(() => companionOrigin({ BABATA_SIDEBAR_PORT: "99999" }), /port/);
  const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: req.url === "/health" })); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await companionHealth(`http://127.0.0.1:${server.address().port}`)).ok, true);
});

await test("CDP commands resolve replies, reject on disconnect, and time out without hanging", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.method === "disconnect") { socket.close(); return; }
    if (request.method === "stall") return;
    if (request.method === "Runtime.evaluate") { socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { text: "Uncaught" } } })); return; }
    socket.send(JSON.stringify({ id: request.id, result: { value: "ok" } }));
  }));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const client = await connectCdp(url, { timeoutMs: 100 });
  assert.deepEqual(await client.send("test"), { value: "ok" });
  await assert.rejects(client.send("stall"), /timed out/);
  await assert.rejects(client.send("disconnect"), /disconnected/);
  await assert.rejects(client.send("test"), /disconnected/);
  client.close();
  await assert.rejects(evaluateCdp({ webSocketDebuggerUrl: url }, "throw 1"), /evaluation failed/);
});

await test("CDP handshake and HTTP body stalls both have deadlines", async (t) => {
  const sockets = new Set();
  const tcp = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); tcp.close(); });
  await assert.rejects(connectCdp(`ws://127.0.0.1:${tcp.address().port}`, { timeoutMs: 80 }), /timed out/);
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(fetchJson(`http://127.0.0.1:${server.address().port}`, {}, 80));
});

await test("failed manual probe startup releases fake servers and does not restore unread settings", async (t) => {
  let lists = 0;
  const cdp = http.createServer((req, res) => {
    if (req.url === "/json/list") lists += 1;
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  cdp.listen(0, "127.0.0.1");
  await once(cdp, "listening");
  t.after(() => { cdp.closeAllConnections(); cdp.close(); });
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const script of ["smoke-translation-links.mjs", "smoke-server-origin-fallback.mjs"]) {
    const before = lists;
    await assert.rejects(promisify(execFile)(process.execPath, [`scripts/${script}`], {
      cwd, timeout: 3000,
      env: {
        ...process.env,
        BABATA_EDGE_CDP: `http://127.0.0.1:${cdp.address().port}`,
        BABATA_EXTENSION_ID: "a".repeat(32),
        BABATA_LINK_SMOKE_PORT: "0",
        BABATA_ORIGIN_FALLBACK_PORT: "0",
      },
    }), (error) => error.code === 1 && /service worker .* not found/.test(error.stderr));
    assert.equal(lists - before, 1, "failure before reading settings must not attempt a restoration");
  }
});
