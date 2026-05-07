/// <reference types="chrome" />

// SW = 极薄 dispatcher.
//
// Architecture:
//   server WS  ──→ offscreen.ts ──[chrome.runtime.sendMessage]──→ SW
//   SW dispatchAction (chrome.scripting.executeScript 在 active tab 跑)
//   SW result ──[chrome.runtime.sendMessage]──→ offscreen.ts ──→ ws.send ──→ server
//
// 为什么不让 SW 直接持 ws?  MV3 SW 30s idle kill, ws 跟着断, setTimeout 不
// fire reconnect — V 实测 babata-sidebar V0 第一次装上 ws 30s 后死掉. Anthropic
// Claude in Chrome 1.0.70 也踩, 用 offscreen document 解 (research/01 finding 3).
//
// V0 暴露的 raw primitive (LLM 在 server 端 reason 完调):
//   tab_metadata / dom_query / dom_inject / dom_set / dom_click / tab_navigate
// 后续按需加, 但每加一个都重新审视: LLM compose 现有 primitive 真做不到这事吗?

async function ensureOffscreen() {
  // chrome.offscreen.hasDocument 在某些版本不存在, 用 getContexts fallback.
  try {
    const has = await (chrome.offscreen as { hasDocument?: () => Promise<boolean> })
      .hasDocument?.();
    if (has) return;
  } catch {
    /* fall through */
  }
  try {
    await chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Persistent WebSocket to babata server (MV3 SW idle bypass).",
    });
  } catch (e) {
    // 已存在的 document 会抛, 忽略.
    const m = (e as Error).message ?? "";
    if (!m.includes("Only a single offscreen document")) {
      console.warn("[babata-sw] createOffscreenDocument failed", e);
    }
  }
}

// ── messages from offscreen / sidepanel ──────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string; payload?: string };

  if (m.type === "babata.keepalive") {
    sendResponse?.({ ok: true });
    return false;
  }

  if (m.type === "babata.ws.inbound" && typeof m.payload === "string") {
    handleWsInbound(m.payload).then(() => sendResponse?.({ ok: true }));
    return true;
  }

  // page-side 推 attention/viewport state → forward 到 server /attention 写 events.jsonl.
  if (m.type === "babata.attention") {
    void (async () => {
      try {
        await fetch("http://127.0.0.1:18791/attention", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(m),
        });
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  // page-side 翻译模块的 batch 翻译请求 → forward 到 server /translate.
  if (m.type === "babata.translate") {
    void (async () => {
      try {
        const resp = await fetch("http://127.0.0.1:18791/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            site: (m as { site?: string }).site ?? "",
            url: (m as { url?: string }).url ?? "",
            target: (m as { target?: string }).target ?? "zh",
            batch: (m as { batch?: unknown }).batch ?? [],
          }),
        });
        if (!resp.ok) {
          sendResponse?.({ ok: false, error: `HTTP ${resp.status}` });
          return;
        }
        const json = (await resp.json()) as { ok?: boolean; results?: unknown };
        sendResponse?.({
          ok: !!json.ok,
          results: Array.isArray(json.results) ? json.results : [],
        });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  // 浮按钮点击 — 打开 sidebar 在 V 当前 window.
  if (m.type === "babata.toggle_sidebar") {
    void (async () => {
      try {
        const winId = sender.tab?.windowId;
        if (winId !== undefined) {
          await chrome.sidePanel.open({ windowId: winId });
        }
      } catch {
        /* 静默 */
      }
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  return false;
});

async function handleWsInbound(raw: string) {
  let inbound: { kind?: string; id?: string; action?: string; args?: Record<string, unknown> };
  try {
    inbound = JSON.parse(raw);
  } catch {
    return;
  }

  if (inbound.kind === "request" && typeof inbound.id === "string" && typeof inbound.action === "string") {
    try {
      const result = await dispatchAction(inbound.action, inbound.args ?? {});
      sendToWs({ kind: "response", id: inbound.id, ok: true, result });
    } catch (e) {
      const err = (e as Error).message ?? String(e);
      sendToWs({ kind: "response", id: inbound.id, ok: false, error: err });
    }
  } else if (inbound.kind === "notification") {
    // server → SW notification → 转 sidepanel.
    chrome.runtime
      .sendMessage({
        type: "babata.notification",
        action: inbound.action,
        args: inbound.args ?? {},
      })
      .catch(() => {});
  }
}

function sendToWs(payload: object) {
  chrome.runtime
    .sendMessage({
      type: "babata.ws.outbound",
      payload: JSON.stringify(payload),
    })
    .catch(() => {});
}

// ── action dispatch (运行在 active tab 的 page-side, SW 序列化 func 注入) ─

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

async function dispatchAction(action: string, args: Record<string, unknown>) {
  switch (action) {
    case "tab_metadata":
      return await actTabMetadata();
    case "dom_query":
      return await actDomQuery(args);
    case "dom_inject":
      return await actDomInject(args);
    case "dom_set":
      return await actDomSet(args);
    case "dom_click":
      return await actDomClick(args);
    case "tab_navigate":
      return await actTabNavigate(args);
    case "bookmarks_search":
      return await actBookmarksSearch(args);
    case "bookmarks_tree":
      return await actBookmarksTree();
    case "bookmarks_create":
      return await actBookmarksCreate(args);
    case "tabs_query":
      return await actTabsQuery(args);
    case "tabs_close":
      return await actTabsClose(args);
    case "tabs_group":
      return await actTabsGroup(args);
    case "history_search":
      return await actHistorySearch(args);
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function actTabMetadata() {
  const tab = await activeTab();
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: () => ({
      url: location.href,
      title: document.title,
      selection: window.getSelection()?.toString() ?? "",
      scroll_y: window.scrollY,
      doc_height: document.documentElement.scrollHeight,
      lang: document.documentElement.lang || "",
    }),
  });
  return exec?.result ?? null;
}

async function actDomQuery(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector : "body";
  const root = typeof args.root === "string" ? args.root : null;
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const props = Array.isArray(args.props)
    ? (args.props as string[])
    : ["tag", "text"];

  const tab = await activeTab();
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    args: [{ selector, root, limit, props }],
    func: (a: { selector: string; root: string | null; limit: number; props: string[] }) => {
      const scope: Document | Element =
        a.root && document.querySelector(a.root)
          ? (document.querySelector(a.root) as Element)
          : document;
      const all = Array.from(scope.querySelectorAll(a.selector)).slice(0, a.limit);
      return all.map((node) => {
        const el = node as HTMLElement;
        const out: Record<string, unknown> = {};
        for (const p of a.props) {
          if (p === "tag") out.tag = el.tagName?.toLowerCase() ?? "";
          else if (p === "id" && el.id) out.id = el.id;
          else if (p === "class" && el.className) out.class = el.className;
          else if (p === "text") {
            const t = (el.innerText ?? el.textContent ?? "").trim();
            out.text = t.length > 1500 ? t.slice(0, 1500) + "…" : t;
          }
          else if (p === "html") out.html = el.innerHTML?.slice(0, 2000) ?? "";
          else if (p === "href") out.href = (el as HTMLAnchorElement).href ?? "";
          else if (p === "value") out.value = (el as HTMLInputElement).value ?? "";
          else if (p === "name") out.name = (el as HTMLInputElement).name ?? "";
          else if (p === "type") out.type = (el as HTMLInputElement).type ?? "";
          else if (p === "placeholder") out.placeholder = (el as HTMLInputElement).placeholder ?? "";
          else if (p === "rect") {
            const r = el.getBoundingClientRect();
            out.rect = {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          } else if (p === "attrs") {
            const a2: Record<string, string> = {};
            for (const at of Array.from(el.attributes)) a2[at.name] = at.value;
            out.attrs = a2;
          }
        }
        return out;
      });
    },
  });
  return exec?.result ?? [];
}

async function actDomInject(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector : "";
  const html = typeof args.html === "string" ? args.html : "";
  const positionRaw =
    typeof args.position === "string" ? (args.position as InsertPosition) : "beforeend";
  if (!selector || !html) throw new Error("dom_inject: selector and html required");

  const tab = await activeTab();
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    args: [{ selector, html, position: positionRaw }],
    func: (a: { selector: string; html: string; position: InsertPosition }) => {
      const els = Array.from(document.querySelectorAll(a.selector));
      let n = 0;
      for (const el of els) {
        try {
          el.insertAdjacentHTML(a.position, a.html);
          n += 1;
        } catch {
          /* skip bad selectors silently */
        }
      }
      return { count: n };
    },
  });
  return exec?.result ?? { count: 0 };
}

async function actDomSet(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector : "";
  const prop = typeof args.prop === "string" ? args.prop : "textContent";
  const value = typeof args.value === "string" ? args.value : "";
  if (!selector) throw new Error("dom_set: selector required");

  const tab = await activeTab();
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    args: [{ selector, prop, value }],
    func: (a: { selector: string; prop: string; value: string }) => {
      const els = Array.from(document.querySelectorAll(a.selector));
      let n = 0;
      for (const el of els) {
        try {
          if (a.prop === "value") {
            (el as HTMLInputElement).value = a.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (a.prop === "textContent") {
            (el as HTMLElement).textContent = a.value;
          } else {
            (el as HTMLElement).setAttribute(a.prop, a.value);
          }
          n += 1;
        } catch {
          /* skip */
        }
      }
      return { count: n };
    },
  });
  return exec?.result ?? { count: 0 };
}

async function actDomClick(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector : "";
  if (!selector) throw new Error("dom_click: selector required");

  const tab = await activeTab();
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    args: [{ selector }],
    func: (a: { selector: string }) => {
      const el = document.querySelector(a.selector) as HTMLElement | null;
      if (!el) return { ok: false, reason: "not found" };
      el.click();
      return { ok: true };
    },
  });
  return exec?.result ?? { ok: false, reason: "no result" };
}

async function actTabNavigate(args: Record<string, unknown>) {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) throw new Error("tab_navigate: url required");
  const tab = await activeTab();
  await chrome.tabs.update(tab.id!, { url });
  return { ok: true, tab_id: tab.id, url };
}

// ── browser-keeper actions: bookmarks / tabs / history ───────────────

async function actBookmarksSearch(args: Record<string, unknown>) {
  const query = typeof args.query === "string" ? args.query : "";
  const max = typeof args.max_results === "number" ? args.max_results : 50;
  const results = await chrome.bookmarks.search(query);
  return results.slice(0, max).map((b) => ({
    id: b.id,
    title: b.title,
    url: b.url,
    parent_id: b.parentId,
    date_added: b.dateAdded,
  }));
}

type BmNode = chrome.bookmarks.BookmarkTreeNode;

function stripFolders(node: BmNode): Record<string, unknown> {
  const out: Record<string, unknown> = { id: node.id, title: node.title };
  if (node.children) {
    const childFolders = node.children.filter((c) => !c.url).map(stripFolders);
    if (childFolders.length > 0) out.children = childFolders;
  }
  return out;
}

async function actBookmarksTree() {
  const tree = await chrome.bookmarks.getTree();
  return tree.map(stripFolders);
}

async function actBookmarksCreate(args: Record<string, unknown>) {
  const title = typeof args.title === "string" ? args.title : "";
  const url = typeof args.url === "string" ? args.url : "";
  const parentId = typeof args.parent_id === "string" ? args.parent_id : undefined;
  if (!title || !url) throw new Error("bookmarks_create: title and url required");
  const node = await chrome.bookmarks.create({ title, url, parentId });
  return { id: node.id, title: node.title, url: node.url, parent_id: node.parentId };
}

async function actTabsQuery(args: Record<string, unknown>) {
  const q: chrome.tabs.QueryInfo = {};
  if (typeof args.active === "boolean") q.active = args.active;
  if (typeof args.audible === "boolean") q.audible = args.audible;
  if (typeof args.pinned === "boolean") q.pinned = args.pinned;
  if (args.current_window === true) q.currentWindow = true;
  if (typeof args.url === "string") q.url = args.url;
  const tabs = await chrome.tabs.query(q);
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    audible: t.audible,
    pinned: t.pinned,
    group_id: t.groupId,
    window_id: t.windowId,
    last_accessed: (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed,
  }));
}

async function actTabsClose(args: Record<string, unknown>) {
  const ids = Array.isArray(args.tab_ids)
    ? args.tab_ids.filter((x): x is number => typeof x === "number")
    : [];
  if (ids.length === 0) throw new Error("tabs_close: tab_ids array required");
  await chrome.tabs.remove(ids);
  return { closed: ids.length };
}

async function actTabsGroup(args: Record<string, unknown>) {
  const ids = Array.isArray(args.tab_ids)
    ? args.tab_ids.filter((x): x is number => typeof x === "number")
    : [];
  if (ids.length === 0) throw new Error("tabs_group: tab_ids array required");
  const groupId = await chrome.tabs.group({ tabIds: ids });
  const updates: chrome.tabGroups.UpdateProperties = {};
  if (typeof args.group_title === "string") updates.title = args.group_title;
  if (typeof args.color === "string") {
    updates.color = args.color as chrome.tabGroups.ColorEnum;
  }
  if (Object.keys(updates).length > 0) {
    await chrome.tabGroups.update(groupId, updates);
  }
  return { group_id: groupId, count: ids.length };
}

async function actHistorySearch(args: Record<string, unknown>) {
  const text = typeof args.text === "string" ? args.text : "";
  const startTime = typeof args.start_ms === "number" ? args.start_ms : 0;
  const endTime = typeof args.end_ms === "number" ? args.end_ms : Date.now();
  const max = typeof args.max_results === "number" ? args.max_results : 100;
  const items = await chrome.history.search({
    text,
    startTime,
    endTime,
    maxResults: max,
  });
  return items.map((h) => ({
    id: h.id,
    url: h.url,
    title: h.title,
    last_visit: h.lastVisitTime,
    visit_count: h.visitCount,
  }));
}

// ── lifecycle ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => ensureOffscreen());

// ── proactive review trigger ─────────────────────────────────────────
// V 切 tab / URL 完成加载 → debounce 5s → POST /proactive 让 server cheap LLM
// 看一眼自决 (翻译 / 推 chip / 静默 — LLM driven, SW 不写死规则).

const PROACTIVE_DEBOUNCE_MS = 5000;
const PROACTIVE_MIN_GAP_MS = 30_000; // 同一 URL 30s 内不重复触发
const proactiveLastFire = new Map<string, number>();
let proactiveTimer: number | null = null;
let proactivePendingTabId: number | null = null;

function scheduleProactive(tabId: number) {
  proactivePendingTabId = tabId;
  if (proactiveTimer !== null) {
    clearTimeout(proactiveTimer);
  }
  proactiveTimer = self.setTimeout(() => {
    proactiveTimer = null;
    void runProactive(proactivePendingTabId!);
  }, PROACTIVE_DEBOUNCE_MS) as unknown as number;
}

async function runProactive(tabId: number) {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const url = tab.url ?? "";
  if (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("view-source:") ||
    url.startsWith("file://")
  ) {
    return;
  }
  const last = proactiveLastFire.get(url) ?? 0;
  if (Date.now() - last < PROACTIVE_MIN_GAP_MS) return;
  proactiveLastFire.set(url, Date.now());

  // 读 V 当前翻译档位 (chrome.storage.local 由 content widget 设置).
  let translationMode = "bilingual";
  try {
    const got = await chrome.storage.local.get("babata.translation_mode");
    if (got["babata.translation_mode"]) {
      translationMode = got["babata.translation_mode"] as string;
    }
  } catch {
    /* default bilingual */
  }

  try {
    await fetch("http://127.0.0.1:18791/proactive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        title: tab.title ?? "",
        tab_id: tabId,
        translation_mode: translationMode,
      }),
    });
  } catch {
    /* server 没起 — 静默 (feedback_self_heal_no_escalate). */
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.active) return;
  scheduleProactive(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  scheduleProactive(info.tabId);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "open-sidebar" && tab?.windowId !== undefined) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch {
      /* 静默 */
    }
  }
});

ensureOffscreen();

export {};
