const CDP = process.env.BABATA_EDGE_CDP || "http://127.0.0.1:9222";
const EXT_ID = process.env.BABATA_EXTENSION_ID || "giaglakcelnaklncmnhnpbmkfiffaflo";
const HOST = "127.0.0.1";
const PORT = Number(process.env.BABATA_ORIGIN_FALLBACK_PORT || "18791");
const ORIGIN = `http://${HOST}:${PORT}`;
const DEAD_ORIGIN = process.env.BABATA_ORIGIN_FALLBACK_DEAD_ORIGIN || "http://127.0.0.1:18793";

let nextId = 1;

async function json(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close() {
          ws.close();
          ws.terminate?.();
        },
      });
    }, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

async function findExtensionWorker() {
  const targets = await json(`${CDP}/json/list`);
  return targets.find((t) => t.type === "service_worker" && t.url.includes(EXT_ID));
}

async function findOptionsPage() {
  const targets = await json(`${CDP}/json/list`);
  return targets.find((t) => t.type === "page" && t.url.includes(`${EXT_ID}/src/options.html`));
}

async function evalOn(target, expression, awaitPromise = false) {
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    return await client.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
  } finally {
    client.close();
  }
}

async function reloadExtension() {
  const worker = await findExtensionWorker();
  if (!worker) throw new Error(`extension service worker ${EXT_ID} not found`);
  try {
    await evalOn(worker, "chrome.runtime.reload()");
  } catch {
    // Reload commonly closes the target before CDP can answer.
  }
  await new Promise((r) => setTimeout(r, 1200));
  const reloaded = await findExtensionWorker();
  if (!reloaded) throw new Error(`extension service worker ${EXT_ID} not found after reload`);
  return reloaded;
}

async function openOptionsPageFromExtension(worker) {
  await evalOn(worker, `new Promise((resolve, reject) => {
    chrome.runtime.openOptionsPage(() => {
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(err));
      else resolve(true);
    });
  })`, true);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const page = await findOptionsPage();
    if (page) return page;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("options page did not open");
}

async function readStorage(worker, keys) {
  const result = await evalOn(worker, `chrome.storage.local.get(${JSON.stringify(keys)})`, true);
  return result.result.value || {};
}

async function setStorage(worker, values) {
  await evalOn(worker, `chrome.storage.local.set(${JSON.stringify(values)})`, true);
}

async function restoreStorage(values) {
  const worker = await findExtensionWorker();
  if (!worker) return;
  const restore = {};
  const remove = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) remove.push(key);
    else restore[key] = value;
  }
  if (remove.length) {
    await evalOn(worker, `chrome.storage.local.remove(${JSON.stringify(remove)})`, true);
  }
  if (Object.keys(restore).length) {
    await setStorage(worker, restore);
  }
}

function startFakeCompanion() {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ createServer }) => {
      const server = createServer((req, res) => {
        if (req.method === "OPTIONS") {
          writeJson(req, res, {});
          return;
        }
        if (req.url === "/health") {
          writeJson(req, res, {
            ok: true,
            companion: "fake",
            cpu: "codex",
            label: "Codex",
            choices: [],
          });
          return;
        }
        if (req.url === "/settings") {
          writeJson(req, res, {
            ok: true,
            translation_provider: {
              base_url: "https://openrouter.ai/api/v1",
              model: "",
              api_key_set: false,
            },
          });
          return;
        }
        writeJson(req, res, { ok: false, error: "not found" }, 404);
      });
      server.once("error", reject);
      server.listen(PORT, HOST, () => resolve(server));
    }).catch(reject);
  });
}

async function defaultCompanionHealthy() {
  try {
    const resp = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    return !!data && typeof data === "object" && data.ok === true;
  } catch {
    return false;
  }
}

function writeJson(req, res, body, status = 200) {
  res.writeHead(status, {
    "access-control-allow-origin": req.headers.origin || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

async function pollStorageOrigin() {
  const deadline = Date.now() + 6000;
  let last = null;
  while (Date.now() < deadline) {
    const worker = await findExtensionWorker();
    if (!worker) throw new Error("extension service worker not found during poll");
    const storage = await readStorage(worker, ["babata.server_origin"]);
    last = storage["babata.server_origin"];
    if (last === ORIGIN) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server origin did not fall back to ${ORIGIN}; last=${last}`);
}

async function pollOptionsPage() {
  const deadline = Date.now() + 6000;
  let last = null;
  while (Date.now() < deadline) {
    const pageTarget = await findOptionsPage();
    if (!pageTarget) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const pageResult = await evalOn(pageTarget, `(() => ({
      ready: document.readyState,
      body: document.body?.innerText || "",
      serverInput: Array.from(document.querySelectorAll("input")).map((i) => i.value).find((v) => /^http:\\/\\/127\\.0\\.0\\.1:/.test(v)) || "",
      badges: Array.from(document.querySelectorAll(".ok,.warn")).map((e) => e.textContent.trim()),
    }))()`, true);
    last = pageResult.result.value;
    if (
      last?.body?.includes("babata settings") &&
      last.serverInput &&
      last.badges?.some((badge) => badge.includes("已连接"))
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`options page did not render in time: ${JSON.stringify(last)}`);
}

async function runProbe() {
  const useExistingCompanion = await defaultCompanionHealthy();
  const server = useExistingCompanion ? null : await startFakeCompanion();
  let optionsPage = null;
  let createdOptionsPage = false;
  let previous = {};
  try {
    const worker = await reloadExtension();
    previous = await readStorage(worker, ["babata.server_origin"]);
    await setStorage(worker, { "babata.server_origin": DEAD_ORIGIN });

    optionsPage = await findOptionsPage();
    if (optionsPage) {
      await evalOn(optionsPage, "location.reload(); true", false);
    } else {
      optionsPage = await openOptionsPageFromExtension(worker);
      createdOptionsPage = true;
    }

    const finalOrigin = await pollStorageOrigin();
    const page = await pollOptionsPage();
    if (page.serverInput !== ORIGIN) {
      throw new Error(`options page did not show fallback origin: ${JSON.stringify(page)}`);
    }
    if (!page.badges.some((badge) => badge.includes("已连接"))) {
      throw new Error(`options page did not show connected state: ${JSON.stringify(page)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      companion: useExistingCompanion ? "existing" : "fake",
      from: DEAD_ORIGIN,
      to: finalOrigin,
      page,
    }, null, 2));
  } finally {
    await restoreStorage({ "babata.server_origin": previous["babata.server_origin"] });
    if (createdOptionsPage && optionsPage?.id) {
      try {
        await json(`${CDP}/json/close/${optionsPage.id}`);
      } catch {
        // ignore close races
      }
    }
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

runProbe().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
