/// <reference types="chrome" />

import {
  STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
  STORAGE_ALWAYS_TRANSLATE_HOSTS,
  STORAGE_TRANSLATION_MODE,
  effectiveTranslationModeForUrl,
  normalizeTranslationRenderMode,
} from "./translation-settings";
import {
  STORAGE_SERVER_ORIGIN,
  getServerOrigin,
  normalizeServerOrigin,
  resolveReachableServerOrigin,
  serverFetch,
} from "./runtime-config";

// SW = 极薄 dispatcher.
//
// Architecture:
//   server WS  ──→ offscreen.ts ──[chrome.runtime.sendMessage]──→ SW
//   SW dispatchAction (chrome.scripting.executeScript 在 active tab 跑)
//   SW result ──[chrome.runtime.sendMessage]──→ offscreen.ts ──→ ws.send ──→ server
//
// 为什么不让 SW 直接持 ws?  MV3 SW 30s idle kill, ws 跟着断, setTimeout 不
// fire reconnect. Use an offscreen document for the long-lived connection.
//
// Raw browser primitives exposed to the companion:
//   tab_metadata / dom_query / dom_inject / dom_set / dom_click / tab_navigate
//   page_snapshot / page_click_ref
// 后续按需加, 但每加一个都重新审视: LLM compose 现有 primitive 真做不到这事吗?

type SnapshotItem = {
  ref: string;
  role: string;
  tag: string;
  name: string;
  selector: string;
  is_new: boolean;
  rect: { x: number; y: number; w: number; h: number };
};

type SnapshotStore = {
  tabId: number;
  url: string;
  selectors: Record<string, string>;
  createdAt: number;
};

type SnapshotRawItem = SnapshotItem & { key: string };
type SnapshotPageResult = {
  url: string;
  title: string;
  items: SnapshotRawItem[];
};
type ProactiveIntent = "prompt_suggestions" | "agent_view";
type ArticleParagraph = {
  id: string;
  type: string;
  text: string;
};
type ArticleExtractResult = {
  url: string;
  title: string;
  site_title: string;
  byline: string;
  published_at: string;
  lang: string;
  excerpt: string;
  text: string;
  markdown: string;
  paragraphs: ArticleParagraph[];
  char_count: number;
  extraction_method: string;
};

const lastSnapshotKeysByTab = new Map<number, { url: string; keys: Set<string> }>();
const snapshotStores = new Map<string, SnapshotStore>();
const SNAPSHOT_STORE_MAX = 20;
const SIDEPANEL_PORT = "babata-sidepanel";
const CHAT_HISTORY_KEY_PREFIX = "babata.chat.history.v1";
const CHAT_HISTORY_LATEST_KEY = `${CHAT_HISTORY_KEY_PREFIX}:latest`;
const sidepanelPorts = new Set<chrome.runtime.Port>();
let lastActivePageContext: {
  tab_id: number;
  window_id: number;
  url: string;
  title: string;
} | null = null;
let lastSidePanelOpenTarget: {
  tab_id?: number;
  window_id?: number;
  ts: number;
} | null = null;

function isPageUrl(url?: string): boolean {
  if (!url) return false;
  return !(
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("view-source:")
  );
}

function rememberActivePage(tab?: chrome.tabs.Tab | null) {
  if (!tab?.id || !isPageUrl(tab.url)) return;
  lastActivePageContext = {
    tab_id: tab.id,
    window_id: tab.windowId,
    url: tab.url ?? "",
    title: tab.title ?? "",
  };
}

async function findActivePageTab(windowId?: number): Promise<chrome.tabs.Tab | null> {
  const queries: chrome.tabs.QueryInfo[] = windowId !== undefined
    ? [{ active: true, windowId }]
    : [
        { active: true, lastFocusedWindow: true },
        { active: true, currentWindow: true },
        { active: true },
      ];
  for (const query of queries) {
    try {
      const tabs = await chrome.tabs.query(query);
      const pageTab = tabs.find((tab) => tab.id !== undefined && isPageUrl(tab.url));
      if (pageTab) {
        rememberActivePage(pageTab);
        return pageTab;
      }
    } catch {
      /* try next query */
    }
  }
  if (lastActivePageContext?.tab_id) {
    try {
      const tab = await chrome.tabs.get(lastActivePageContext.tab_id);
      if (tab?.id && isPageUrl(tab.url)) {
        rememberActivePage(tab);
        return tab;
      }
    } catch {
      lastActivePageContext = null;
    }
  }
  return null;
}

function intMessageField(source: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function sidePanelTargetFromMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
): { tabId?: number; windowId?: number } {
  const record = msg && typeof msg === "object" ? msg as Record<string, unknown> : {};
  let tabId = intMessageField(record, "tab_id", "tabId");
  let windowId = intMessageField(record, "window_id", "windowId");

  if (sender.tab?.id !== undefined && tabId === undefined) tabId = sender.tab.id;
  if (sender.tab?.windowId !== undefined && windowId === undefined) windowId = sender.tab.windowId;
  rememberActivePage(sender.tab);

  if (tabId !== undefined && tabId <= 0) tabId = undefined;
  if (windowId !== undefined && windowId < 0) windowId = undefined;
  return { tabId, windowId };
}

function rememberSidePanelOpenTarget(target: { tabId?: number; windowId?: number }) {
  if (target.tabId === undefined && target.windowId === undefined) return;
  lastSidePanelOpenTarget = {
    tab_id: target.tabId,
    window_id: target.windowId,
    ts: Date.now(),
  };
}

async function recentSidePanelOpenTab(): Promise<chrome.tabs.Tab | null> {
  const target = lastSidePanelOpenTarget;
  if (!target || Date.now() - target.ts > 10_000) return null;
  if (target.tab_id !== undefined) {
    try {
      const tab = await chrome.tabs.get(target.tab_id);
      if (tab?.id && isPageUrl(tab.url)) {
        rememberActivePage(tab);
        return tab;
      }
    } catch {
      lastSidePanelOpenTarget = null;
      return null;
    }
  }
  if (target.window_id !== undefined) {
    return await findActivePageTab(target.window_id);
  }
  return null;
}

function sidePanelPathForTarget(target: { tabId?: number; windowId?: number }) {
  const params = new URLSearchParams();
  if (target.tabId !== undefined) params.set("tab_id", String(target.tabId));
  if (target.windowId !== undefined) params.set("window_id", String(target.windowId));
  const query = params.toString();
  return query ? `src/sidepanel.html?${query}` : "src/sidepanel.html";
}

async function configureSidePanelForTarget(target: { tabId?: number; windowId?: number }) {
  if (target.tabId === undefined && target.windowId === undefined) return;
  const path = sidePanelPathForTarget(target);
  try {
    if (target.tabId !== undefined) {
      await chrome.sidePanel.setOptions({ tabId: target.tabId, path, enabled: true });
      return;
    }
    await chrome.sidePanel.setOptions({ path, enabled: true });
  } catch (e) {
    console.debug("[babata-sw] sidePanel.setOptions failed:", (e as Error)?.message ?? e);
  }
}

function notifySidePanelTarget(target: { tabId?: number; windowId?: number }) {
  if (target.tabId === undefined && target.windowId === undefined) return;
  chrome.runtime
    .sendMessage({
      type: "babata.sidepanel_target",
      tab_id: target.tabId,
      window_id: target.windowId,
    })
    .catch(() => {});
}

async function openSidePanelForTarget(target: { tabId?: number; windowId?: number }) {
  const { tabId, windowId } = target;
  rememberSidePanelOpenTarget(target);
  notifySidePanelTarget(target);
  if (tabId !== undefined) {
    await chrome.sidePanel.open(
      windowId !== undefined ? { tabId, windowId } : { tabId },
    );
    void configureSidePanelForTarget(target);
    return;
  }
  if (windowId !== undefined) {
    await chrome.sidePanel.open({ windowId });
    void configureSidePanelForTarget(target);
  }
}

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

function chatStorageKeyFromMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const key = (msg as Record<string, unknown>).storage_key;
  return typeof key === "string" && key.startsWith(CHAT_HISTORY_KEY_PREFIX) ? key : null;
}

function normalizeChatSnapshot(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.messages)) return null;
  return record;
}

// ── messages from offscreen / sidepanel ──────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDEPANEL_PORT) return;
  sidepanelPorts.add(port);
  void ensureOffscreen();
  port.onMessage.addListener((msg) => {
    const m = msg as { type?: string; ts?: number } | undefined;
    if (m?.type === "babata.sidepanel_ping") {
      try {
        port.postMessage({ type: "babata.sidepanel_pong", ts: m.ts ?? Date.now() });
      } catch {
        /* disconnected */
      }
    }
  });
  port.onDisconnect.addListener(() => {
    sidepanelPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string; payload?: string };

  if (m.type === "babata.keepalive") {
    sendResponse?.({ ok: true });
    return false;
  }

  if (m.type === "babata.server_origin.get") {
    void (async () => {
      try {
        sendResponse?.({ ok: true, origin: await resolveReachableServerOrigin(await getServerOrigin()) });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  if (m.type === "babata.ws.inbound" && typeof m.payload === "string") {
    handleWsInbound(m.payload).then(() => sendResponse?.({ ok: true }));
    return true;
  }

  if (m.type === "babata.current_tab_context") {
    const tab = sender.tab;
    sendResponse?.({
      ok: !!tab?.id,
      tab_id: tab?.id,
      window_id: tab?.windowId,
      url: tab?.url ?? "",
      title: tab?.title ?? "",
    });
    return false;
  }

  if (m.type === "babata.active_page_context") {
    void (async () => {
      try {
        const tab = await recentSidePanelOpenTab() ?? await findActivePageTab();
        sendResponse?.({
          ok: !!tab?.id,
          tab_id: tab?.id,
          window_id: tab?.windowId,
          url: tab?.url ?? "",
          title: tab?.title ?? "",
        });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  if (m.type === "babata.chat.snapshot_write") {
    void (async () => {
      try {
        const key = chatStorageKeyFromMessage(msg);
        const record = normalizeChatSnapshot((msg as Record<string, unknown>).record);
        if (!key || !record) {
          sendResponse?.({ ok: false, error: "invalid chat snapshot" });
          return;
        }
        await chrome.storage.local.set({
          [key]: record,
          [CHAT_HISTORY_LATEST_KEY]: record,
        });
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  if (m.type === "babata.chat.snapshot_clear") {
    void (async () => {
      try {
        const key = chatStorageKeyFromMessage(msg);
        if (!key) {
          sendResponse?.({ ok: false, error: "invalid storage key" });
          return;
        }
        await chrome.storage.local.remove([key, CHAT_HISTORY_LATEST_KEY]);
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  if (m.type === "babata.chat.snapshot_mark_stopped") {
    void (async () => {
      try {
        const key = chatStorageKeyFromMessage(msg);
        if (!key) {
          sendResponse?.({ ok: false, error: "invalid storage key" });
          return;
        }
        const got = await chrome.storage.local.get([key]);
        const record = normalizeChatSnapshot(got[key]);
        if (record) {
          const stopped = { ...record, streaming: false, updated_at: Date.now() };
          await chrome.storage.local.set({
            [key]: stopped,
            [CHAT_HISTORY_LATEST_KEY]: stopped,
          });
        }
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  if (
    m.type === "babata.chat.start" ||
    m.type === "babata.chat.abort" ||
    m.type === "babata.chat.clear"
  ) {
    void (async () => {
      try {
        await ensureOffscreen();
        const targetType =
          m.type === "babata.chat.start"
            ? "babata.offscreen.chat.start"
            : m.type === "babata.chat.abort"
              ? "babata.offscreen.chat.abort"
              : "babata.offscreen.chat.clear";
        const resp = await chrome.runtime.sendMessage({
          ...(msg as Record<string, unknown>),
          type: targetType,
        });
        sendResponse?.(resp ?? { ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  // page-side 推 attention/viewport state → forward 到 server /attention 写 events.jsonl.
  if (m.type === "babata.attention") {
    void (async () => {
      try {
        await serverFetch("/attention", {
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

  // page-side translation trace instrumentation →
  // server /translate_trace 写 events.jsonl client_trace kind. fire-and-forget.
  if (m.type === "babata.translate_trace") {
    void (async () => {
      try {
        await serverFetch("/translate_trace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: (m as { url?: string }).url ?? "",
            traces: (m as { traces?: unknown }).traces ?? [],
          }),
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
        const resp = await serverFetch("/translate", {
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

  // Widget click: open sidebar in the current window.
  if (m.type === "babata.toggle_sidebar") {
    void (async () => {
      try {
        await openSidePanelForTarget(sidePanelTargetFromMessage(msg, sender));
      } catch {
        /* 静默 */
      }
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  if (m.type === "babata.prepare_sidebar") {
    void (async () => {
      try {
        await configureSidePanelForTarget(sidePanelTargetFromMessage(msg, sender));
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  // page widget 主动触发: 单击要 prompt chips, 双击要桌宠锐评.
  // 复用 server /proactive endpoint, 但用 intent 明确语义.
  if (m.type === "babata.suggest_prompts" || m.type === "babata.agent_view") {
    void (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse?.({ ok: false, error: "no sender tab" });
          return;
        }
        const intent: ProactiveIntent =
          m.type === "babata.agent_view" ? "agent_view" : "prompt_suggestions";
        const ok = await requestProactive(tabId, intent);
        sendResponse?.({ ok });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  // page widget 三击头像 — 净化阅读当前文章. 扩展先抽取正文, server 再做 LLM
  // 保真重构/锐评, 结果通过 notification 回 sidepanel.
  if (m.type === "babata.clean_read") {
    void (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse?.({ ok: false, error: "no sender tab" });
          return;
        }
        const ok = await requestCleanRead(tabId);
        sendResponse?.({ ok });
      } catch (e) {
        sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) });
      }
    })();
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_SERVER_ORIGIN]) return;
  const origin = normalizeServerOrigin(changes[STORAGE_SERVER_ORIGIN].newValue);
  chrome.runtime
    .sendMessage({ type: "babata.server_origin.changed", origin })
    .catch(() => {});
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
    void dispatchNotification(inbound.action ?? "", inbound.args ?? {});
  }
}

async function dispatchNotification(action: string, args: Record<string, unknown>) {
  const message = {
    type: "babata.notification",
    action,
    args,
  };

  if (action === "mascot_speak") {
    try {
      const tab = await targetTab(args);
      await chrome.tabs.sendMessage(tab.id!, message);
      return;
    } catch (e) {
      console.debug(
        "[babata-sw] mascot notification dropped:",
        (e as Error)?.message ?? e,
      );
      return;
    }
  }

  if (action.startsWith("clean_read_")) {
    try {
      const tab = await targetTab(args);
      await chrome.tabs.sendMessage(tab.id!, message);
    } catch (e) {
      console.debug(
        "[babata-sw] clean_read page notification dropped:",
        action,
        (e as Error)?.message ?? e,
      );
    }
  }

  // Extension-page notifications: sidepanel / popup iframe.
  chrome.runtime
    .sendMessage(message)
    .catch((e) => {
      console.debug(
        "[babata-sw] notification dropped (no receiver):",
        action,
        (e as Error)?.message ?? e,
      );
    });
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

function intArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

async function targetTab(args: Record<string, unknown> = {}): Promise<chrome.tabs.Tab> {
  const explicitTabId = intArg(args, "tab_id", "tabId");
  if (explicitTabId !== undefined) {
    const tab = await chrome.tabs.get(explicitTabId);
    if (!tab?.id) throw new Error(`tab not found: ${explicitTabId}`);
    return tab;
  }

  const windowId = intArg(args, "window_id", "windowId");
  const tab = await findActivePageTab(windowId);
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

function pruneSnapshotStores(now = Date.now()) {
  for (const [id, store] of snapshotStores) {
    if (now - store.createdAt > 10 * 60_000) {
      snapshotStores.delete(id);
    }
  }
  const ordered = [...snapshotStores.entries()].sort(
    (a, b) => a[1].createdAt - b[1].createdAt,
  );
  while (ordered.length > SNAPSHOT_STORE_MAX) {
    const [id] = ordered.shift()!;
    snapshotStores.delete(id);
  }
}

async function dispatchAction(action: string, args: Record<string, unknown>) {
  switch (action) {
    case "tab_metadata":
      return await actTabMetadata(args);
    case "dom_query":
      return await actDomQuery(args);
    case "dom_inject":
      return await actDomInject(args);
    case "dom_set":
      return await actDomSet(args);
    case "dom_click":
      return await actDomClick(args);
    case "page_snapshot":
      return await actPageSnapshot(args);
    case "article_extract":
      return await actArticleExtract(args);
    case "page_click_ref":
      return await actPageClickRef(args);
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

async function actTabMetadata(args: Record<string, unknown>) {
  const tab = await targetTab(args);
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
  const result = (exec?.result ?? null) as Record<string, unknown> | null;
  return result ? { ...result, tab_id: tab.id, window_id: tab.windowId } : null;
}

async function actDomQuery(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector : "body";
  const root = typeof args.root === "string" ? args.root : null;
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const props = Array.isArray(args.props)
    ? (args.props as string[])
    : ["tag", "text"];

  const tab = await targetTab(args);
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

  const tab = await targetTab(args);
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

  const tab = await targetTab(args);
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

  const tab = await targetTab(args);
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

async function actPageSnapshot(args: Record<string, unknown>) {
  const rawLimit = intArg(args, "limit") ?? 120;
  const limit = Math.max(1, Math.min(rawLimit, 250));
  const tab = await targetTab(args);
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    args: [{ limit }],
    func: (a: { limit: number }) => {
      const escapeCss = (value: string) => {
        const css = globalThis.CSS as { escape?: (v: string) => string } | undefined;
        return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };
      const escapeAttr = (value: string) =>
        value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const oneLine = (value: string, max = 240) => {
        const text = value.replace(/\s+/g, " ").trim();
        return text.length > max ? `${text.slice(0, max)}...` : text;
      };
      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        if (
          rect.bottom < 0 ||
          rect.right < 0 ||
          rect.top > window.innerHeight ||
          rect.left > window.innerWidth
        ) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        if ((el as HTMLElement).hidden || el.getAttribute("aria-hidden") === "true") {
          return false;
        }
        return true;
      };
      const roleFor = (el: HTMLElement) => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button" || tag === "summary") return "button";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "input") {
          const type = (el as HTMLInputElement).type || "text";
          if (type === "checkbox" || type === "radio") return type;
          if (type === "submit" || type === "button") return "button";
          return "textbox";
        }
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "li") return "listitem";
        if (tag === "td" || tag === "th") return "cell";
        if (tag === "label") return "label";
        return "text";
      };
      const nameFor = (el: HTMLElement) => {
        const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
        if (aria.trim()) return oneLine(aria);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const inputText =
            el.value ||
            el.placeholder ||
            el.getAttribute("name") ||
            el.getAttribute("type") ||
            "";
          if (inputText.trim()) return oneLine(inputText);
        }
        if (el instanceof HTMLImageElement && el.alt) return oneLine(el.alt);
        return oneLine(el.innerText || el.textContent || "");
      };
      const unique = (selector: string, el: Element) => {
        try {
          const matches = document.querySelectorAll(selector);
          return matches.length === 1 && matches[0] === el;
        } catch {
          return false;
        }
      };
      const selectorFor = (el: HTMLElement) => {
        const tag = el.tagName.toLowerCase();
        if (el.id) {
          const selector = `#${escapeCss(el.id)}`;
          if (unique(selector, el)) return selector;
        }
        for (const attr of ["data-testid", "data-test", "data-cy", "aria-label", "name"]) {
          const value = el.getAttribute(attr);
          if (!value) continue;
          const selector = `${tag}[${attr}="${escapeAttr(value)}"]`;
          if (unique(selector, el)) return selector;
        }
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.nodeType === Node.ELEMENT_NODE) {
          const curTag = cur.tagName.toLowerCase();
          if (cur instanceof HTMLElement && cur.id) {
            const idSelector = `#${escapeCss(cur.id)}`;
            if (unique(idSelector, cur)) {
              parts.unshift(idSelector);
              break;
            }
          }
          if (cur === document.body) {
            parts.unshift("body");
            break;
          }
          if (cur === document.documentElement) {
            parts.unshift("html");
            break;
          }
          const siblings = Array.from(cur.parentElement?.children ?? []).filter(
            (child) => child.tagName === cur!.tagName,
          );
          const index = Math.max(1, siblings.indexOf(cur) + 1);
          parts.unshift(`${curTag}:nth-of-type(${index})`);
          cur = cur.parentElement;
        }
        return parts.join(" > ");
      };

      const interactive = [
        "a[href]",
        "button",
        "input:not([type='hidden'])",
        "textarea",
        "select",
        "summary",
        "[role]",
        "[contenteditable='true']",
        "[onclick]",
        "[tabindex]:not([tabindex='-1'])",
      ].join(",");
      const readable = "h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,label";
      const nodes = Array.from(
        document.querySelectorAll(`${interactive},${readable}`),
      ) as HTMLElement[];
      const seenSelectors = new Set<string>();
      const seenText = new Set<string>();
      const items: SnapshotRawItem[] = [];

      for (const el of nodes) {
        if (items.length >= a.limit) break;
        if (!isVisible(el)) continue;
        const role = roleFor(el);
        const name = nameFor(el);
        const interactiveRole = !["text", "heading", "listitem", "cell", "label"].includes(role);
        if (!name && !interactiveRole) continue;
        if (!interactiveRole && name.length < 2) continue;
        const selector = selectorFor(el);
        if (!selector || seenSelectors.has(selector)) continue;
        const textKey = `${role}|${name}`;
        if (!interactiveRole && seenText.has(textKey)) continue;
        seenSelectors.add(selector);
        seenText.add(textKey);
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const key = `${role}|${selector}|${name.slice(0, 120)}`;
        items.push({
          ref: `e${items.length + 1}`,
          role,
          tag,
          name,
          selector,
          is_new: false,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          key,
        });
      }
      return { url: location.href, title: document.title, items };
    },
  });

  const page = exec?.result as SnapshotPageResult | undefined;
  if (!page) return { snapshot_id: "", tab_id: tab.id, window_id: tab.windowId, items: [] };

  const previousStore = lastSnapshotKeysByTab.get(tab.id!);
  const previous = previousStore?.url === page.url ? previousStore.keys : new Set<string>();
  const currentKeys = new Set<string>();
  const selectors: Record<string, string> = {};
  const items = page.items.map((item) => {
    const key = item.key || `${item.role}|${item.selector}|${item.name}`;
    currentKeys.add(key);
    selectors[item.ref] = item.selector;
    return {
      ref: item.ref,
      role: item.role,
      tag: item.tag,
      name: item.name,
      selector: item.selector,
      is_new: !previous.has(key),
      rect: item.rect,
    };
  });
  lastSnapshotKeysByTab.set(tab.id!, { url: page.url, keys: currentKeys });

  const snapshotId = `${tab.id}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  snapshotStores.set(snapshotId, {
    tabId: tab.id!,
    url: page.url,
    selectors,
    createdAt: Date.now(),
  });
  pruneSnapshotStores();

  const lines = items.map((item) => {
    const mark = item.is_new ? "*" : " ";
    const label = JSON.stringify(item.name || item.role);
    const rect = `${item.rect.x},${item.rect.y} ${item.rect.w}x${item.rect.h}`;
    return `${mark}[${item.ref}] ${item.role}<${item.tag}> ${label} @${rect}`;
  });

  return {
    snapshot_id: snapshotId,
    tab_id: tab.id,
    window_id: tab.windowId,
    url: page.url,
    title: page.title,
    items,
    lines,
  };
}

async function actPageClickRef(args: Record<string, unknown>) {
  const snapshotId = typeof args.snapshot_id === "string" ? args.snapshot_id : "";
  const ref = typeof args.ref === "string" ? args.ref : "";
  if (!snapshotId || !ref) throw new Error("page_click_ref: snapshot_id and ref required");
  const store = snapshotStores.get(snapshotId);
  if (!store) throw new Error(`page_click_ref: snapshot not found or expired: ${snapshotId}`);
  const explicitTabId = intArg(args, "tab_id", "tabId");
  if (explicitTabId !== undefined && explicitTabId !== store.tabId) {
    throw new Error(`page_click_ref: snapshot belongs to tab ${store.tabId}`);
  }
  const selector = store.selectors[ref];
  if (!selector) throw new Error(`page_click_ref: ref not found in snapshot: ${ref}`);

  const tab = await chrome.tabs.get(store.tabId);
  if (!tab?.id) throw new Error(`page_click_ref: tab not found: ${store.tabId}`);
  if (tab.url && store.url && tab.url !== store.url) {
    throw new Error("page_click_ref: snapshot is stale because the tab URL changed");
  }
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ selector }],
    func: (a: { selector: string }) => {
      const el = document.querySelector(a.selector) as HTMLElement | null;
      if (!el) return { ok: false, reason: "selector no longer found", selector: a.selector };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* not focusable */
      }
      el.click();
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        selector: a.selector,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    },
  });
  return exec?.result ?? { ok: false, reason: "no result", selector };
}

async function actTabNavigate(args: Record<string, unknown>) {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) throw new Error("tab_navigate: url required");
  const tab = await targetTab(args);
  await chrome.tabs.update(tab.id!, { url });
  return { ok: true, tab_id: tab.id, url };
}

async function actArticleExtract(args: Record<string, unknown>) {
  const tab = await targetTab(args);
  const result = await extractArticleFromTab(tab.id!);
  return { ...result, tab_id: tab.id, window_id: tab.windowId };
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

async function extractArticleFromTab(tabId: number): Promise<ArticleExtractResult> {
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      type P = { id: string; type: string; text: string };
      const redact = (value: string) =>
        value
          .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, "sk-[redacted]")
          .replace(/\b(id_token|access_token|refresh_token)=([^&\s]+)/gi, "$1=[redacted]");
      const oneLine = (value: string, max = 1200) => {
        const text = redact(value).replace(/\s+/g, " ").trim();
        return text.length > max ? `${text.slice(0, max)}...` : text;
      };
      const meta = (...names: string[]) => {
        for (const name of names) {
          const el = document.querySelector(
            `meta[name="${name}"],meta[property="${name}"]`,
          ) as HTMLMetaElement | null;
          const value = el?.content?.trim();
          if (value) return value;
        }
        return "";
      };
      const candidateSelectors = [
        "article",
        "main",
        "[role='main']",
        "[itemprop='articleBody']",
        "body",
      ];
      const root = candidateSelectors
        .map((selector) => document.querySelector(selector))
        .find((el): el is Element => !!el && (el.textContent || "").trim().length > 80)
        || document.body;
      const blocks = Array.from(
        root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption"),
      ).slice(0, 260);
      const paragraphs: P[] = [];
      const seen = new Set<string>();
      const push = (type: string, text: string) => {
        const cleaned = redact(text).replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
        if (!cleaned) return;
        if (type !== "heading" && type !== "code" && cleaned.length < 12) return;
        const key = `${type}|${cleaned.slice(0, 180)}`;
        if (seen.has(key)) return;
        seen.add(key);
        paragraphs.push({ id: `p${paragraphs.length + 1}`, type, text: cleaned });
      };

      for (const block of blocks) {
        const tag = block.tagName.toLowerCase();
        const raw = block.textContent || "";
        if (/^h[1-6]$/.test(tag)) push("heading", oneLine(raw, 220));
        else if (tag === "li") push("list", oneLine(raw, 500));
        else if (tag === "blockquote") push("quote", oneLine(raw, 900));
        else if (tag === "pre") push("code", raw.trim().slice(0, 1600));
        else if (tag === "figcaption") push("caption", oneLine(raw, 500));
        else push("paragraph", oneLine(raw, 1200));
        if (paragraphs.reduce((sum, p) => sum + p.text.length, 0) > 70_000) break;
      }

      if (paragraphs.length < 3) {
        const fallback = (root.textContent || document.body.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        for (const chunk of fallback.split(/(?<=[。！？.!?])\s+|\n{2,}/).slice(0, 80)) {
          push("paragraph", oneLine(chunk, 1200));
        }
      }

      const markdown = paragraphs
        .map((p) => {
          if (p.type === "heading") return `\n## ${p.text}\n`;
          if (p.type === "list") return `- ${p.text}`;
          if (p.type === "quote") return `> ${p.text}`;
          if (p.type === "code") return `\n\`\`\`\n${p.text}\n\`\`\`\n`;
          if (p.type === "caption") return `_图注：${p.text}_`;
          return p.text;
        })
        .join("\n\n")
        .trim()
        .slice(0, 70_000);
      const text = paragraphs.map((p) => `[${p.id}] ${p.text}`).join("\n\n").slice(0, 70_000);

      return {
        url: location.href,
        title: document.title || meta("og:title", "twitter:title"),
        site_title: meta("og:site_name", "application-name"),
        byline: meta("author", "article:author", "parsely-author"),
        published_at: meta("article:published_time", "pubdate", "date", "datePublished"),
        lang: document.documentElement.lang || "",
        excerpt: meta("description", "og:description", "twitter:description"),
        text,
        markdown,
        paragraphs,
        char_count: text.length,
        extraction_method: root === document.body ? "body_blocks" : "semantic_root_blocks",
      };
    },
  });
  const result = exec?.result as ArticleExtractResult | undefined;
  if (!result) throw new Error("article_extract: no result");
  return result;
}

// ── lifecycle ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => ensureOffscreen());

chrome.tabs.onActivated.addListener((info) => {
  void chrome.tabs.get(info.tabId).then(rememberActivePage).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.title || changeInfo.status === "complete")) {
    rememberActivePage(tab);
  }
});

void findActivePageTab().catch(() => {});

// ── manual proactive trigger ─────────────────────────────────────────
// Widget 单击打开 chat popup 后 → prompt_suggestions;
// Widget 双击头像唤醒 → agent_view 一句话锐评.
// 不再在 tab 切换 / URL 完成加载时自动触发.

async function requestProactive(tabId: number, intent: ProactiveIntent): Promise<boolean> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
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
    return false;
  }

  // Read the current translation mode from chrome.storage.local.
  let translationMode: "off" | "bilingual" | "replace" = "replace";
  try {
    const got = await chrome.storage.local.get([
      STORAGE_TRANSLATION_MODE,
      STORAGE_ALWAYS_TRANSLATE_HOSTS,
      STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
    ]);
    translationMode = effectiveTranslationModeForUrl(
      normalizeTranslationRenderMode(got[STORAGE_TRANSLATION_MODE]),
      got[STORAGE_ALWAYS_TRANSLATE_HOSTS],
      url,
      got[STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS],
    );
  } catch {
    /* default bilingual */
  }

  try {
    await serverFetch("/proactive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        title: tab.title ?? "",
        tab_id: tabId,
        window_id: tab.windowId,
        translation_mode: translationMode,
        intent,
      }),
    });
    return true;
  } catch {
    /* server 没起 — 静默 (feedback_self_heal_no_escalate). */
    return false;
  }
}

async function requestCleanRead(tabId: number): Promise<boolean> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
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
    return false;
  }

  const runId = `${tabId}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  void dispatchNotification("clean_read_started", {
    run_id: runId,
    url,
    title: tab.title ?? "",
    tab_id: tabId,
    window_id: tab.windowId,
  });

  try {
    const article = await extractArticleFromTab(tabId);
    if (!article.text.trim() || article.char_count < 200) {
      throw new Error("没抽到足够正文");
    }
    const resp = await serverFetch("/clean_read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: runId,
        url,
        title: tab.title ?? article.title ?? "",
        tab_id: tabId,
        window_id: tab.windowId,
        article,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return true;
  } catch (e) {
    void dispatchNotification("clean_read_error", {
      run_id: runId,
      url,
      title: tab.title ?? "",
      error: (e as Error).message ?? String(e),
      tab_id: tabId,
      window_id: tab.windowId,
    });
    return false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  lastSnapshotKeysByTab.delete(tabId);
  for (const [snapshotId, store] of snapshotStores) {
    if (store.tabId === tabId) snapshotStores.delete(snapshotId);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "open-sidebar" && tab?.windowId !== undefined) {
    try {
      await openSidePanelForTarget({ tabId: tab.id, windowId: tab.windowId });
    } catch {
      /* 静默 */
    }
  }
});

ensureOffscreen();

export {};
