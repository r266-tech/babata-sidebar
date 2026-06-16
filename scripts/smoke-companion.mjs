import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.BABATA_SMOKE_COMPANION_PORT || "18792");
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;
const EXT_ORIGIN = "chrome-extension://babata-smoke-test";
const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), "babata-sidebar-smoke-"));
const binDir = path.join(dataDir, "bin");
const fakeProviderKey = ["smoke", "provider", "key"].join("-");
let child;

function request(pathname, opts = {}) {
  return fetch(`${ORIGIN}${pathname}`, {
    ...opts,
    headers: {
      origin: EXT_ORIGIN,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const resp = await request("/health");
      if (resp.ok) return await resp.json();
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err.message || String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`companion did not start: ${lastError}`);
}

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function wsClientFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const mask = randomBytes(4);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff])]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = offset + 2;
    if (length === 126) {
      if (buffer.length - header < 2) break;
      length = buffer.readUInt16BE(header);
      header += 2;
    } else if (length === 127) {
      if (buffer.length - header < 8) break;
      length = Number(buffer.readBigUInt64BE(header));
      header += 8;
    }
    let mask;
    if (masked) {
      if (buffer.length - header < 4) break;
      mask = buffer.subarray(header, header + 4);
      header += 4;
    }
    if (buffer.length - header < length) break;
    const payload = Buffer.from(buffer.subarray(header, header + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    offset = header + length;
    if (opcode === 0x1) frames.push(payload.toString("utf8"));
  }
  return { frames, rest: buffer.subarray(offset) };
}

async function connectToolWs() {
  const socket = netConnect(PORT, HOST);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  let messageHandler = () => {};
  let opened = false;
  let buffer = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "GET /ws HTTP/1.1",
        `Host: ${HOST}:${PORT}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${EXT_ORIGIN}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!opened) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        if (!/^HTTP\/1\.1 101\b/.test(header) || !header.includes(expectedAccept)) {
          reject(new Error(`WebSocket handshake failed:\n${header}`));
          socket.destroy();
          return;
        }
        opened = true;
        buffer = buffer.subarray(headerEnd + 4);
        resolve();
      }
      const parsed = parseWsFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) messageHandler(frame);
    });
  });
  return {
    onMessage(fn) {
      messageHandler = fn;
    },
    send(value) {
      socket.write(wsClientFrame(value));
    },
    close() {
      socket.end();
    },
  };
}

try {
  await mkdir(binDir, { recursive: true });
  const fakeCli = [
    "#!/bin/sh",
    "name=$(basename \"$0\")",
    "prompt=\"$*\"",
    "case \"$prompt\" in",
    "  *Browser\\ tool\\ results*) printf 'TOOL_OK from tool result\\n' ;;",
    "  *SMOKE_HISTORY_TOKEN*) printf 'HISTORY_OK SMOKE_HISTORY_TOKEN\\n' ;;",
    "  *USE_BROWSER_TOOL*) printf '<tool_call>{\"action\":\"tab_metadata\",\"args\":{},\"reason\":\"smoke\"}</tool_call>\\n' ;;",
    "  *) printf '%s fake reply\\n' \"$name\" ;;",
    "esac",
    "",
  ].join("\n");
  await writeFile(path.join(binDir, "codex"), fakeCli, { mode: 0o700 });
  await writeFile(path.join(binDir, "claude"), fakeCli, { mode: 0o700 });
  await chmod(path.join(binDir, "codex"), 0o700);
  await chmod(path.join(binDir, "claude"), 0o700);

  child = spawn(process.execPath, ["companion/server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      BABATA_SIDEBAR_HOST: HOST,
      BABATA_SIDEBAR_PORT: String(PORT),
      BABATA_SIDEBAR_DATA_DIR: dataDir,
      OPENROUTER_API_KEY: "",
      OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const health = await waitForHealth();
  assert(health.ok === true, "health failed", health);
  assert(Array.isArray(health.choices), "health did not include CPU choices", health);

  const save = await request("/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cpu: "claude",
      translation_provider: {
        base_url: "https://example.test/v1",
        api_key: fakeProviderKey,
        model: "test-model",
      },
    }),
  });
  const saved = await save.json();
  assert(save.ok && saved.ok === true, "settings save failed", saved);
  assert(saved.translation_provider.api_key_set === true, "settings did not persist key flag", saved);
  assert(saved.translation_provider.api_key === fakeProviderKey, "settings save did not return saved key", saved);
  assert(saved.translation_provider.model === "test-model", "settings did not persist model", saved);

  const read = await request("/settings");
  const got = await read.json();
  assert(got.translation_provider.api_key_set === true, "settings read lost key flag", got);
  assert(got.translation_provider.api_key === fakeProviderKey, "settings read did not return saved key", got);

  const healthAfterSave = await request("/health");
  const gotHealth = await healthAfterSave.json();
  assert(!JSON.stringify(gotHealth).includes(fakeProviderKey), "health leaked API key", gotHealth);

  const chat = await request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  const chatText = await chat.text();
  assert(chat.ok, "chat endpoint failed", chatText);
  assert(chatText.includes("\"type\":\"text_delta\""), "chat did not stream text_delta", chatText);
  assert(chatText.includes("claude fake reply"), "chat did not call configured fake Claude CLI", chatText);

  const historyChat = await request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "what token did I ask you to remember?",
      messages: [
        { role: "user", text: "remember SMOKE_HISTORY_TOKEN" },
        { role: "assistant", text: "ok" },
        { role: "user", text: "what token did I ask you to remember?" },
      ],
    }),
  });
  const historyChatText = await historyChat.text();
  assert(historyChat.ok, "history chat endpoint failed", historyChatText);
  assert(historyChatText.includes("HISTORY_OK SMOKE_HISTORY_TOKEN"), "chat did not include supplied history in model prompt", historyChatText);

  const debugChat = await request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "show the debug prompt",
      debug_prompt: true,
      messages: [
        { role: "user", text: "remember DEBUG_PROMPT_TOKEN" },
        { role: "assistant", text: "ok" },
        { role: "user", text: "show the debug prompt" },
      ],
      page_context: {
        url: "https://babata.local/debug",
        title: "Debug Prompt Page",
        url_changed: true,
        selection: "DEBUG_SELECTION_TOKEN",
      },
    }),
  });
  const debugChatText = await debugChat.text();
  assert(debugChat.ok, "debug chat endpoint failed", debugChatText);
  assert(debugChatText.includes("\"type\":\"debug_prompt\""), "chat did not emit debug_prompt", debugChatText);
  assert(debugChatText.includes("DEBUG_PROMPT_TOKEN"), "debug prompt did not include supplied history", debugChatText);
  assert(debugChatText.includes("DEBUG_SELECTION_TOKEN"), "debug prompt did not include page selection", debugChatText);

  const ws = await connectToolWs();
  ws.onMessage((frame) => {
    const msg = JSON.parse(frame);
    if (msg.kind !== "request" || !msg.id) return;
    ws.send({
      kind: "response",
      id: msg.id,
      ok: true,
      result: {
        url: "https://babata.local/tool-smoke",
        title: "Tool Smoke Page",
        selection: "",
      },
    });
  });
  const toolChat = await request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "USE_BROWSER_TOOL" }),
  });
  const toolChatText = await toolChat.text();
  ws.close();
  assert(toolChat.ok, "tool chat endpoint failed", toolChatText);
  assert(toolChatText.includes("\"type\":\"tool_use\""), "chat did not emit tool_use", toolChatText);
  assert(toolChatText.includes("\"type\":\"tool_result\""), "chat did not emit tool_result", toolChatText);
  assert(toolChatText.includes("TOOL_OK from tool result"), "chat did not continue after browser tool result", toolChatText);

  const noOriginHistory = await fetch(`${ORIGIN}/history?limit=1`, {
    signal: AbortSignal.timeout(5000),
  });
  assert(noOriginHistory.status === 403, "history should require Origin", {
    status: noOriginHistory.status,
    text: await noOriginHistory.text(),
  });
  const history = await request("/history?limit=10");
  const historyPayload = await history.json();
  assert(history.ok && Array.isArray(historyPayload.turns), "history endpoint failed", historyPayload);
  assert(historyPayload.turns.some((turn) => turn.text?.includes("TOOL_OK")), "history did not record assistant turns", historyPayload);

  const attention = await request("/attention", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "smoke" }),
  });
  assert(attention.ok, "attention endpoint failed", await attention.text());

  const noProvider = await request("/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batch: [] }),
  });
  const translated = await noProvider.json();
  assert(noProvider.ok && translated.ok === true, "empty translate batch failed", translated);

  console.log(JSON.stringify({ ok: true, health, saved: got, chat: "ok" }, null, 2));
} finally {
  if (child) child.kill("SIGTERM");
  await rm(dataDir, { recursive: true, force: true });
}
