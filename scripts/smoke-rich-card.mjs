const CDP = process.env.BABATA_EDGE_CDP || "http://127.0.0.1:9222";
const EXT_ID = process.env.BABATA_EXTENSION_ID || "giaglakcelnaklncmnhnpbmkfiffaflo";
const SERVER_URL = process.env.BABATA_SIDEBAR_SERVER || "http://127.0.0.1:18791/health";
const WAIT_MS = Number(process.env.BABATA_RICH_CARD_WAIT_MS || "1350");

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

async function setReplaceMode(worker) {
  const before = await evalOn(
    worker,
    `chrome.storage.local.get("babata.translation_mode")`,
    true,
  );
  const previous = before.result.value?.["babata.translation_mode"];
  await evalOn(
    worker,
    `chrome.storage.local.set({"babata.translation_mode":"replace"})`,
    true,
  );
  return async () => {
    const current = await findExtensionWorker();
    if (!current) return;
    if (previous === undefined) {
      await evalOn(current, `chrome.storage.local.remove("babata.translation_mode")`, true);
    } else {
      await evalOn(
        current,
        `chrome.storage.local.set({"babata.translation_mode":${JSON.stringify(previous)}})`,
        true,
      );
    }
  };
}

async function runProbe() {
  const worker = await reloadExtension();
  const restoreMode = await setReplaceMode(worker);
  let pageClient = null;
  let page = null;
  try {
    page = await json(`${CDP}/json/new?${encodeURIComponent(SERVER_URL)}`, { method: "PUT" });
    pageClient = await connect(page.webSocketDebuggerUrl);
    await pageClient.send("Runtime.enable");
    await new Promise((r) => setTimeout(r, 1500));
    await pageClient.send("Runtime.evaluate", {
      expression: `(() => {
        document.body.innerHTML = "";
        document.body.style.margin = "24px";
        const card = document.createElement("a");
        card.id = "bbt-rich-fixture";
        card.href = "#fixture";
        card.style.cssText = "display:block;width:360px;border:1px solid #ccd6dd;border-radius:14px;padding:16px;color:#111;text-decoration:none;font:16px system-ui;background:#fff;";
        const img = document.createElement("img");
        img.alt = "";
        img.width = 180;
        img.height = 120;
        img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
        img.style.cssText = "display:block;width:180px;height:120px;margin:0 auto 12px;background:#09c;object-fit:cover;";
        const title = document.createElement("span");
        title.id = "bbt-rich-title";
        title.style.cssText = "display:block;line-height:1.3;";
        title.textContent = "SVG Animations From Common UX Implementations to Complex Responsive Animation";
        card.append(img, title);
        document.body.append(card);
        return true;
      })()`,
      returnByValue: true,
      userGesture: true,
    });
    await new Promise((r) => setTimeout(r, WAIT_MS));
    const result = await pageClient.send("Runtime.evaluate", {
      expression: `(() => {
        const card = document.getElementById("bbt-rich-fixture");
        if (!card) return { missing: true };
        return {
          anchorLeaf: card.hasAttribute("data-bbt-leaf"),
          anchorDisplay: getComputedStyle(card).display,
          titleLeaf: document.getElementById("bbt-rich-title")?.hasAttribute("data-bbt-leaf") ?? null,
          leafNodes: Array.from(card.querySelectorAll("[data-bbt-leaf]")).map((el) => ({
            tag: el.tagName,
            id: el.id,
            text: el.textContent.trim(),
          })),
        };
      })()`,
      returnByValue: true,
    });
    const value = result.result.value;
    if (!value || value.missing) throw new Error("fixture missing");
    if (value.anchorLeaf) throw new Error(`rich card wrapper was marked leaf: ${JSON.stringify(value)}`);
    if (!value.titleLeaf) throw new Error(`rich card title was not marked leaf: ${JSON.stringify(value)}`);
    console.log(JSON.stringify({ ok: true, ...value }, null, 2));
  } finally {
    if (page?.id) {
      try {
        await json(`${CDP}/json/close/${page.id}`);
      } catch {
        // ignore close races
      }
    }
    pageClient?.close();
    await restoreMode();
  }
}

runProbe().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
