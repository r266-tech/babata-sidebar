const CDP = process.env.BABATA_EDGE_CDP || "http://127.0.0.1:9222";
const EXT_ID = process.env.BABATA_EXTENSION_ID || "giaglakcelnaklncmnhnpbmkfiffaflo";
const WAIT_MS = Number(process.env.BABATA_LINK_SMOKE_WAIT_MS || "2500");
const HOST = "127.0.0.1";
const PORT = Number(process.env.BABATA_LINK_SMOKE_PORT || "18793");
const ORIGIN = `http://${HOST}:${PORT}`;
const serverState = {
  translateRequests: 0,
  lastTranslatePayload: null,
};

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
    // The reload usually closes the target before CDP replies.
  }
  await new Promise((r) => setTimeout(r, 1200));
  const reloaded = await findExtensionWorker();
  if (!reloaded) throw new Error(`extension service worker ${EXT_ID} not found after reload`);
  return reloaded;
}

async function withStorage(worker, values, fn) {
  const keys = Object.keys(values);
  const before = await evalOn(worker, `chrome.storage.local.get(${JSON.stringify(keys)})`, true);
  const previous = before.result.value || {};
  await evalOn(worker, `chrome.storage.local.set(${JSON.stringify(values)})`, true);
  try {
    return await fn();
  } finally {
    const current = await findExtensionWorker();
    if (!current) return;
    const restore = {};
    const remove = [];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(previous, key)) restore[key] = previous[key];
      else remove.push(key);
    }
    if (remove.length) {
      await evalOn(current, `chrome.storage.local.remove(${JSON.stringify(remove)})`, true);
    }
    if (Object.keys(restore).length) {
      await evalOn(current, `chrome.storage.local.set(${JSON.stringify(restore)})`, true);
    }
  }
}

function startFakeCompanion() {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ createServer }) => {
      const server = createServer((req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders(req));
          res.end();
          return;
        }
        if (req.url === "/health") {
          writeJson(req, res, { ok: true, companion: "fake" });
          return;
        }
        if (req.url === "/translate" && req.method === "POST") {
          serverState.translateRequests += 1;
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            const payload = JSON.parse(body || "{}");
            serverState.lastTranslatePayload = payload;
            const results = Array.isArray(payload.batch)
              ? payload.batch.map((item) => ({
                hash: item.hash,
                translated: "请参阅 [[BBT_LINK_1]]我的介绍[[/BBT_LINK_1]] 了解这个项目。",
              }))
              : [];
            writeJson(req, res, { ok: true, results });
          });
          return;
        }
        if (req.url === "/attention" || req.url === "/translate_trace") {
          writeJson(req, res, { ok: true });
          return;
        }
        writeJson(req, res, { ok: false, error: "not found" }, 404);
      });
      server.once("error", reject);
      server.listen(PORT, HOST, () => resolve(server));
    }).catch(reject);
  });
}

function corsHeaders(req) {
  const origin = req.headers.origin || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "application/json; charset=utf-8",
  };
}

function writeJson(req, res, body, status = 200) {
  res.writeHead(status, corsHeaders(req));
  res.end(`${JSON.stringify(body)}\n`);
}

async function runProbe() {
  const server = await startFakeCompanion();
  const worker = await reloadExtension();
  let pageClient = null;
  let page = null;
  try {
    await withStorage(worker, {
      "babata.server_origin": ORIGIN,
      "babata.translation_mode": "replace",
      "babata.translation_always_disabled_hosts": [],
    }, async () => {
      page = await json(`${CDP}/json/new?${encodeURIComponent(`${ORIGIN}/health`)}`, { method: "PUT" });
      pageClient = await connect(page.webSocketDebuggerUrl);
      await pageClient.send("Runtime.enable");
      await new Promise((r) => setTimeout(r, 1500));
      await pageClient.send("Runtime.evaluate", {
        expression: `(() => {
          document.title = "Babata link translation smoke";
          document.body.innerHTML = '<main><p id="fixture">Patterns for agents. See <a id="source-link" href="https://simonwillison.net/2026/Feb/23/agentic-engineering-patterns/">my introduction</a> for more on this project.</p></main>';
          document.body.style.cssText = "margin:24px;font:16px/1.5 system-ui;";
          return true;
        })()`,
        returnByValue: true,
        userGesture: true,
      });
      await new Promise((r) => setTimeout(r, WAIT_MS));
      let value = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await pageClient.send("Runtime.evaluate", {
          expression: `(() => {
            const source = document.getElementById("fixture");
            const tr = source?.nextElementSibling;
            const link = tr?.querySelector("a[href]");
            return {
              sourceLeaf: source?.hasAttribute("data-bbt-leaf") ?? false,
              sourceHash: source?.getAttribute("data-bbt-hash") ?? "",
              translationTag: tr?.tagName ?? "",
              translationClass: tr?.className?.toString() ?? "",
              translationText: tr?.textContent?.trim() ?? "",
              translatedHref: link?.getAttribute("href") ?? "",
              translatedText: link?.textContent?.trim() ?? "",
              sourceDisplay: source ? getComputedStyle(source).display : "",
            };
          })()`,
          returnByValue: true,
        });
        value = result.result.value;
        if (value?.translatedHref) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!value?.sourceLeaf) throw new Error(`fixture was not translated: ${JSON.stringify(value)}`);
      const requestText = serverState.lastTranslatePayload?.batch?.[0]?.text || "";
      if (!requestText.includes("[[BBT_LINK_1]]my introduction[[/BBT_LINK_1]]")) {
        throw new Error(`translation request did not preserve source link markers: ${JSON.stringify(serverState)}`);
      }
      if (value.translatedHref !== "https://simonwillison.net/2026/Feb/23/agentic-engineering-patterns/") {
        throw new Error(`translated link href was not preserved: ${JSON.stringify({
          page: value,
          serverState,
        })}`);
      }
      if (value.translatedText !== "我的介绍") {
        throw new Error(`translated link text was not restored: ${JSON.stringify(value)}`);
      }
      console.log(JSON.stringify({ ok: true, ...value }, null, 2));
    });
  } finally {
    if (page?.id) {
      try {
        await json(`${CDP}/json/close/${page.id}`);
      } catch {
        // ignore close races
      }
    }
    pageClient?.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

runProbe().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
