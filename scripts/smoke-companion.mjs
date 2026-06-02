import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

try {
  await mkdir(binDir, { recursive: true });
  const fakeCli = "#!/bin/sh\nname=$(basename \"$0\")\nprintf '%s fake reply\\n' \"$name\"\n";
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
