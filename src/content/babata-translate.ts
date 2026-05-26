/// <reference types="chrome" />

import DOMPurify from "dompurify";
import {
  STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
  STORAGE_ALWAYS_TRANSLATE_HOSTS,
  STORAGE_SELECTION_TRANSLATION,
  STORAGE_TRANSLATION_MODE as STORAGE_MODE,
  effectiveTranslationModeForHost,
  hostnameFromUrl,
  normalizeHostList,
  normalizeHostname,
  normalizeTranslationRenderMode as normalizeMode,
  type TranslationMode,
  type TranslationRenderMode,
} from "../translation-settings";

// page-side translation engine.
//
// 核心 design:
//   IntersectionObserver — viewport 内段落入境触发翻译
//   MutationObserver — SPA (推特/Notion 等) 重 mount 时, 已 hash 段重 inject 不调 LLM
//   L1 cache (page-side Map<hash,html>) — 同 page 内重 mount 命中
//   L2 cache (server-side sqlite) — 跨 tab/session, 24h TTL (server 端处理)
//
// 解决 V 推特"拉下没翻 / 拉回上消失"两大坑.
//
// 安全: 译文来自 LLM (untrusted), 走 DOMPurify 白名单 (inline format only).

const HASH_ATTR = "data-bbt-hash";
const LEAF_ATTR = "data-bbt-leaf";
const TR_CLASS = "bbt-tr";
const TEARDOWN_EVENT = "babata:translate-teardown";
// inline-leaf (X span/a/strong) 跟 block-leaf (P/DIV/blockquote) 的 sibling 译文
// 视觉应跟 leaf 一致 — block-leaf 后 block 占行, inline-leaf 后 inline 流畅. 用 marker
// class 区分, 让 CSS rule (mode-aware) 控制装饰. inline TR_STYLE 的 border-left+block
// 装饰在 replace 模式下 = 噪声 (V 实测 X 推文每段加左 border 大字号堆叠 broken).
const TR_INLINE_CLASS = "bbt-tr-inline";
const TR_BLOCK_CLASS = "bbt-tr-block";
const TR_NATIVE_CLASS = "bbt-tr-native";
const TR_INPLACE_CLASS = "bbt-tr-inplace";
const SRC_CLASS = "bbt-src";
const INPLACE_ATTR = "data-bbt-inplace";
const SELECTION_SETTING_EVENT = "babata:selection-translation-setting";

const SAFE_HTML_OPTS = {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "code", "br", "span", "mark"],
  ALLOWED_ATTR: ["href", "title", "class", "target", "rel", "referrerpolicy"],
};

// LLM 翻一次, 永远 sibling .bbt-tr 注入. "替换/双语/不翻" 纯 CSS 切换 0 LLM (V 设计).
// 老 "auto" innerHTML 替换跟 React reconcile fundamentally 抢 DOM (X 实测同 leaf SPAN
// 10s 被外部 reconcile 9 次), 5 源 (沉浸式 v1.28.5/read-frog/kiss/fluentread/old-immersive)
// 全选 sibling 注入, 没人替换原文. 替换观感由 CSS hide leaf 元素实现, DOM 不抢.
type Mode = TranslationMode;

const isSubframe = window.top !== window.self;
const translationOwnerUrl = isSubframe && document.referrer ? document.referrer : location.href;
const currentHost = hostnameFromUrl(translationOwnerUrl) || normalizeHostname(location.hostname);
let baseMode: TranslationRenderMode = "replace";
let mode: Mode = "replace";
let selectionTranslationEnabled = false;
let alwaysTranslateHosts: string[] = [];
let alwaysTranslateDisabledHosts: string[] = [];
const cache = new Map<string, string>();
interface QueueItem {
  el: HTMLElement;
  text: string;
  visible: boolean;
  attempts: number;
}
const queue = new Map<string, QueueItem>();
let flushTimer: number | null = null;
let flushInProgress = false;

const TARGET_LANG = "zh";
// 24/batch sonnet 一次接 ~5KB prompt 不慢, 减少 V 视口内段先后翻顺序差
// (V 反馈"右侧名字先翻 / 正文后翻"). 进一步要降到 1 batch cover 视口内全部
// 需要 IO viewport-priority + immediateBudget (deep agent Q5).
const BATCH_SIZE = 24;
const FLUSH_DEBOUNCE_MS = 300;
// queue cap 兜底防 V 滚万段时内存爆 — 实际 V 滚 timeline 千段也到不了.
// 不再按 viewport drop scroll-out: V 明确 "DOM 里能读到的尽量都翻".
const QUEUE_MAX = 5000;
const MISSING_RESULT_MAX_RETRIES = 2;
const TRANSPORT_MAX_RETRIES = 5;
const TRANSPORT_RETRY_BASE_MS = 1500;
const TRANSPORT_RETRY_MAX_MS = 30_000;
const VISIBLE_PRIORITY_MARGIN_PX = 800;
const CUSTOM_TEXT_SHELL_INPLACE_MAX_TEXT = 1400;

const SELECTION_DEBOUNCE_MS = 220;
const SELECTION_MAX_TEXT = 1600;
const SELECTION_POPUP_WIDTH = 360;
const SELECTION_POPUP_MAX_HEIGHT = 260;

// ── attention / viewport (page-side state push) ───────────────────────
const visibleHashes = new Set<string>();
let viewportPushTimer: number | null = null;
let lastInteractAt = Date.now();
let isIdle = false;
let idleTimer: number | null = null;
const IDLE_THRESHOLD_MS = 30_000;
const VIEWPORT_PUSH_DEBOUNCE_MS = 1000;

// Extension reload 时, 老 content script 仍在 page 上, chrome.runtime API 同步抛
// "Extension context invalidated" — `.catch()` 接不到 sync throw. 一次 set true
// 后所有 chrome.* 调用 short-circuit, 静默直到 V 刷 page reload 我.
let extInvalidated = false;
let transportFailures = 0;
let nextFlushNotBefore = 0;
function isInvalidatedError(e: unknown): boolean {
  return /Extension context invalidated/.test((e as Error)?.message ?? String(e));
}
function safeChromeSend<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (extInvalidated) return Promise.resolve(undefined);
  try {
    return fn().catch((e) => {
      if (isInvalidatedError(e)) {
        extInvalidated = true;
        teardownAll();
      }
      return undefined;
    });
  } catch (e) {
    if (isInvalidatedError(e)) {
      extInvalidated = true;
      teardownAll();
    }
    return Promise.resolve(undefined);
  }
}

function pushAttention(payload: Record<string, unknown>) {
  void safeChromeSend(() =>
    chrome.runtime.sendMessage({ type: "babata.attention", url: location.href, ...payload }),
  );
}

function scheduleViewportPush() {
  if (viewportPushTimer !== null) return;
  viewportPushTimer = window.setTimeout(() => {
    viewportPushTimer = null;
    pushAttention({
      kind: "viewport",
      visible_hashes: Array.from(visibleHashes),
      visible_n: visibleHashes.size,
    });
  }, VIEWPORT_PUSH_DEBOUNCE_MS);
}

function setupAttentionWatchers() {
  const onVisibilityChange = () => {
    pushAttention({ kind: "attention", visibility: document.visibilityState });
  };
  const onFocus = () => pushAttention({ kind: "attention", focus: "yes" });
  const onBlur = () => pushAttention({ kind: "attention", focus: "no" });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  registerCleanup(() => document.removeEventListener("visibilitychange", onVisibilityChange));
  registerCleanup(() => window.removeEventListener("focus", onFocus));
  registerCleanup(() => window.removeEventListener("blur", onBlur));

  const onInteract = () => {
    lastInteractAt = Date.now();
    if (isIdle) {
      isIdle = false;
      pushAttention({ kind: "attention", idle: "no" });
    }
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      isIdle = true;
      pushAttention({
        kind: "attention",
        idle: "yes",
        idle_sec: Math.round((Date.now() - lastInteractAt) / 1000),
      });
    }, IDLE_THRESHOLD_MS);
  };
  ["mousemove", "keydown", "scroll", "click", "touchstart"].forEach((ev) => {
    document.addEventListener(ev, onInteract, { passive: true });
    registerCleanup(() => document.removeEventListener(ev, onInteract));
  });
  onInteract();
}

// ── universal leaf-text walk (V 反 site-specific: 通用, 翻肉眼可见所有) ─

// 段内 inline 标签 (沉浸式 generalRule.inlineTags 同源 + babata 补).
// fast path: 99% 命中 (DIV/SPAN/A/P 这种常见 tag). 不命中走 CSS fallback (Q1).
const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDO", "BIG", "CITE", "CODE", "DEL", "DFN", "EM",
  "FONT", "I", "IMG", "INS", "KBD", "LABEL", "MARK", "Q", "RB", "RP",
  "RT", "RUBY", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP",
  "TIME", "TT", "U", "VAR", "WBR", "BR",
]);

// 一定是 block 的 HTML spec tag — fast path 拒 inline 判断, 不走 getComputedStyle.
const FORCE_BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER",
  "MAIN", "NAV", "UL", "OL", "LI", "TABLE", "TR", "TD", "TH",
  "THEAD", "TBODY", "TFOOT", "FIGURE", "FIGCAPTION", "BLOCKQUOTE",
  "DL", "DT", "DD", "HR", "FORM", "FIELDSET", "DETAILS", "SUMMARY",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

// Immersive generalRule core subset: 阈值/保留标签/数学选择器/原子块/断句缩写.
// 原始配置见 Edge 沉浸式 v1.28.5 default_config.content.json generalRule.
const PARAGRAPH_MIN_TEXT_COUNT = 4;
const BLOCK_MIN_TEXT_COUNT = 24;
const MAIN_FRAME_MIN_TEXT_COUNT = 50;
const LONG_BUILD_DOM_LENGTH = 3000;
const STAY_ORIGINAL_TAGS = new Set([
  "CODE", "TT", "IMG", "SUP", "SUB", "SAMP", "MATH", "SEMANTICS", "MROW",
  "MO", "MFRAC", "MSUP", "MI", "MN", "MSQRT", "D-MATH", "KBD",
]);
const ADDITIONAL_STAY_ORIGINAL_SELECTORS = [
  "span.katex", ".math-block", ".MathJax_Preview", ".MathJax_Display",
  ".math-container", ".MathJax", ".MathJax_SVG", "math-renderer",
  '[aria-labelledby^="MathJax-SVG"]', ".mwe-math-element", "em[translate=no]",
  "code[translate=no]", "a[translate=no]", "b[translate=no]", "span.math.inline",
  "span.math.display", ".ltx_Math", ".mathjax-block", ".MathJax_CHTML", "kbd",
  "span.pretex-inline", "span.math-inline", ".reference-citations", ".code",
  "[data-test='json-editor']", ".jp-CodeMirrorEditor", "cds-code-snippet",
  ".interactive-markdown__code", "span.variable[translate=no]", "#ace-editor",
  "table.processedcode",
];
const ATOMIC_BLOCK_SELECTORS = ["relin-hc", "x-p", "app-keyword-content"];
const YOUTUBE_CAPTION_EXCLUDE_SELECTORS = [
  "#ytp-caption-window-container",
  ".ytp-caption-window-container",
  ".ytp-caption-segment",
  ".caption-window",
];
const STAY_ORIGINAL_SELECTOR = ADDITIONAL_STAY_ORIGINAL_SELECTORS.join(", ");
const ATOMIC_BLOCK_SELECTOR = ATOMIC_BLOCK_SELECTORS.join(", ");
const RICH_MEDIA_SELECTOR = [
  "img", "picture", "video", "canvas", "iframe", "object", "embed", "[role='img']",
].join(", ");
const RICH_MEDIA_MIN_EDGE_PX = 32;
const RICH_MEDIA_MIN_AREA_PX = 2048;
const RICH_MEDIA_SCAN_LIMIT = 160;
const DEFAULT_MIN_TEXT_COUNT = Math.min(PARAGRAPH_MIN_TEXT_COUNT, MAIN_FRAME_MIN_TEXT_COUNT);
const MAX_TRANSLATABLE_TEXT_COUNT = Math.max(4000, LONG_BUILD_DOM_LENGTH);
const LINE_BREAK_ABBREVIATION_RE = /(?:etc\.|Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|U\.S\.|U\.K\.|Co\.|Inc\.|Ltd\.|St\.)$/i;

// 子树根本不该进 (REJECT — TreeWalker 不再深入). 含已注入译文.
const EXCLUDE_SELECTOR = [
  "pre", "code", "script", "style", "noscript", "template",
  "svg", "math", "head", "title", "meta", "link",
  "input", "textarea", "select", "button",
  "nav", '[role="navigation"]', '[role="banner"]', '[role="toolbar"]',
  '[role="button"]', '[role="menu"]', '[role="menubar"]', '[role="menuitem"]',
  '[role="option"]', '[role="tab"]', '[role="tablist"]',
  "details", "summary",
  '[contenteditable="true"]', '[aria-hidden="true"]',
  ...ADDITIONAL_STAY_ORIGINAL_SELECTORS,
  ...YOUTUBE_CAPTION_EXCLUDE_SELECTORS,
  `.${TR_CLASS}`,
].join(", ");
const MAIN_CONTENT_SELECTOR = "article, .markdown-body, [itemprop='articleBody']";
const AUXILIARY_CONTENT_SELECTOR = [
  "aside",
  '[role="complementary"]',
  ".Layout-sidebar",
  ".prc-PageLayout-Pane-AyzHK",
  ".BorderGrid",
].join(", ");
const VISUALLY_HIDDEN_CLASS_RE = /(?:^|\s)(?:sr-only|visually-hidden)(?:\s|$)|VisuallyHidden|ScreenReader/i;

// leaf 物理 mark — 写 DOM attr (data-bbt-leaf). page 删该元素 attr 跟随消失, 不像
// WeakSet 永久 lock. 5 源 (kiss/read-frog/fluentread/old-immersive/沉浸式) 全选物理
// 探测, 没人用逻辑 lock. babata 老的 claimed: WeakSet 是反模式 — 已 leaf 的子树新加
// 节点 (展开更多场景) 走 collectTranslatable 被 hasClaimedAncestor 挡死, 漏翻;
// 另已 inject 被外力清 .bbt-tr 后, claimed 仍 lock 永远不能 reinject.
const multiCache = new WeakMap<HTMLElement, boolean>();
// inline 判断缓存 — getComputedStyle 同步 reflow, 同元素重复调贵.
const inlineCache = new WeakMap<HTMLElement, boolean>();
const hiddenCache = new WeakMap<HTMLElement, boolean>();
// MO sentinel — 自己 inject 的 .bbt-tr font 加进, MO addedNodes 跳 (kiss translator.js:319,711).
const skipMoNodes = new WeakSet<Node>();
// X SPA reconcile race debounce — 同 hash inject 后 N ms 内 MO 触发 processCandidate skip,
// 让 X reconcile 完成稳态. V 实测 800ms 仍闪 (events.jsonl 同 hash 1 秒 4 hit), codex F1
// 警告"X 可能 900-1500ms 周期", 调 1500ms 给 X reconcile burst 留余地.
const recentlyInjected = new Map<string, number>();
const INJECT_DEBOUNCE_MS = 1500;
// 抄沉浸式 v1.28.5 `Js` Map (content_main_beauty.js:45580-45596) — TRAILING stable-window.
// 之前用 leading throttle (first-wins) 错: X reconcile 第一次 mutation 拿 unstable text
// 就 process, 后续 1.5s 内全拦, "显示更多" 展开后新内容 fall in throttle window 漏翻.
// trailing 正解: 每次 mutation 更新 ts, 1100ms 静默无新 mutation 才真 process. 拿到的
// 是 X reconcile 完成后的稳定 text, 1 次 process inject 不闪. tick interval 200ms 扫.
const STABLE_WINDOW_MS = 1100;
const stableWindowMap = new Map<HTMLElement, { ts: number; src: TraceSource }>();
let stableWindowTimer: number | null = null;
// element in-flight 锁 — 同 element 已 enqueue 在 LLM 中, 新 mutation 不重 enqueue.
const inFlightElements = new WeakSet<HTMLElement>();
// hash in-flight 锁 — 跨 element instance 同 text. X swap SPAN 时新 instance 不在
// inFlightElements (WeakSet 是 element 级), 重新走 doProcessCandidate, cache 还没 set
// (flush async 在 server roundtrip 中), 又 enqueue 触发并发 flush. 两次 server 调用同
// text 返不同 LLM 译文, cache.set 覆盖. V 实测 hash 535d6390 4 次 add 不同译文铁证.
// hash 锁让同 text 跨 instance 串行: 第一次 enqueue 锁, flush 完返结果再解锁.
const inFlightHashes = new Set<string>();

// ── client trace instrumentation (V "开发要收集数据方便调试") ─
// 每次 processCandidate 在每个 decision 点记一条 trace. batch flush 经 SW POST
// /translate_trace, server 写 events.jsonl client_trace kind. V tail 直接看
// 每个 decision 不再 hypothesize 闪烁/漏翻 root cause.
type TraceSource = "io" | "mo_add" | "mo_char" | "rerun" | "init";
type TraceDecision = "throttle" | "not_translatable" | "already" | "debounce"
  | "cache_inject" | "enqueue" | "in_flight_defer" | "stable_pending"
  | "stale_result" | "skip_no_text" | "missing_result_retry" | "missing_result_drop"
  | "transport_retry" | "transport_drop";
interface TraceRecord {
  ts: number;
  src: TraceSource;
  dec: TraceDecision;
  hash: string;
  text_len: number;
  el: string;
}
const traces: TraceRecord[] = [];
const TRACE_FLUSH_MS = 2000;
const TRACE_BATCH_MAX = 50;
let traceTimer: number | null = null;
function pathOf(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const testid = el.getAttribute("data-testid");
  const role = el.getAttribute("role");
  const cls = (el.className?.toString() || "").slice(0, 30);
  return tag
    + (testid ? `[testid=${testid}]` : "")
    + (role ? `[role=${role}]` : "")
    + (cls ? `.${cls.split(" ")[0]}` : "");
}
function trace(
  src: TraceSource,
  el: HTMLElement,
  hash: string,
  dec: TraceDecision,
  text?: string,
) {
  const source = text ?? sourceText(el);
  traces.push({
    ts: Date.now(),
    src, dec, hash,
    text_len: source.trim().length,
    el: pathOf(el),
  });
  if (traces.length >= TRACE_BATCH_MAX) {
    flushTraces();
    return;
  }
  if (traceTimer === null) {
    traceTimer = window.setTimeout(flushTraces, TRACE_FLUSH_MS);
  }
}
function flushTraces() {
  if (traceTimer !== null) {
    clearTimeout(traceTimer);
    traceTimer = null;
  }
  if (traces.length === 0) return;
  const batch = traces.splice(0);
  void safeChromeSend(() =>
    chrome.runtime.sendMessage({
      type: "babata.translate_trace",
      url: location.href,
      traces: batch,
    }),
  );
}

function activeShadowRoots(): ShadowRoot[] {
  for (const root of Array.from(observedShadowRoots)) {
    if (!root.host.isConnected) observedShadowRoots.delete(root);
  }
  return Array.from(observedShadowRoots);
}

function translationRoots(): Array<Document | ShadowRoot> {
  return [document, ...activeShadowRoots()];
}

function applyShadowRootModeAttr(root: ShadowRoot) {
  if (root.host instanceof HTMLElement) {
    root.host.setAttribute("data-bbt-mode", mode);
  }
}

function registerShadowRoot(root: ShadowRoot) {
  observedShadowRoots.add(root);
  applyShadowRootModeAttr(root);
  injectModeStyle(root);
  observeMutations(root);
}

// periodic cleanup 防 Map leak (long timeline 累积). cleanupTimer 留 handle 给 lifecycle.
let cleanupTimer: number | null = null;
let mo: MutationObserver | null = null;
let observedMutationRoots = new WeakSet<ParentNode>();
let observedShadowRoots = new Set<ShadowRoot>();
const cleanupFns: Array<() => void> = [];

function registerCleanup(fn: () => void) {
  cleanupFns.push(fn);
}

function startCleanupTimer() {
  if (cleanupTimer !== null) return;
  cleanupTimer = window.setInterval(() => {
    const cutoff = Date.now() - INJECT_DEBOUNCE_MS * 4;
    for (const [h, ts] of recentlyInjected) {
      if (ts < cutoff) recentlyInjected.delete(h);
    }
  }, INJECT_DEBOUNCE_MS * 8);
}

// 抄沉浸式 v1.28.5 C() function (45578-45605) — trailing stable-window scanner.
// 每 200ms 扫 stableWindowMap, 静默 1100ms+ 的 element 提升到 doProcessCandidate.
function startStableWindowTimer() {
  if (stableWindowTimer !== null) return;
  stableWindowTimer = window.setInterval(() => {
    if (stableWindowMap.size === 0) return;
    const now = Date.now();
    const ready: { el: HTMLElement; src: TraceSource }[] = [];
    for (const [el, info] of stableWindowMap) {
      if (now - info.ts > STABLE_WINDOW_MS) {
        ready.push({ el, src: info.src });
        stableWindowMap.delete(el);
      }
    }
    for (const { el, src } of ready) {
      if (el.isConnected) doProcessCandidate(el, src);
    }
  }, 200);
}
function teardownAll() {
  const w = window as unknown as { __babataTranslateBooted?: boolean };
  w.__babataTranslateBooted = false;
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (stableWindowTimer !== null) {
    clearInterval(stableWindowTimer);
    stableWindowTimer = null;
  }
  if (mo !== null) {
    mo.disconnect();
    mo = null;
  }
  clearAllTranslations();
  removeModeStyles();
  observedMutationRoots = new WeakSet<ParentNode>();
  observedShadowRoots = new Set<ShadowRoot>();
  if (io !== null) {
    io.disconnect();
    io = null;
  }
  if (viewportPushTimer !== null) {
    clearTimeout(viewportPushTimer);
    viewportPushTimer = null;
  }
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  queue.clear();
  stableWindowMap.clear();
  inFlightHashes.clear();
  visibleHashes.clear();
  for (const fn of cleanupFns.splice(0)) {
    try {
      fn();
    } catch {
      /* ignore cleanup failure */
    }
  }
  flushTraces();  // 刷尾巴 trace 不丢 (extension reload / pagehide).
  if (traceTimer !== null) {
    clearTimeout(traceTimer);
    traceTimer = null;
  }
}

function broadcastTeardown() {
  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));
}

// CSS display 是 inline-like (read-frog isInlineDisplay filter.ts:41-63).
// "contents" = 元素自身不渲染, 子直挂父 — 行为接 inline.
// "ruby*" = 东亚字符注音流, 跟 inline 同段.
function isInlineDisplay(display: string): boolean {
  const d = display.trim().toLowerCase();
  if (!d) return false;
  if (d === "contents") return true;
  if (d.startsWith("inline")) return true;
  return d === "ruby" || d.startsWith("ruby-");
}

// inline 判断: fast path → CSS fallback (Q1: cover custom element / display:contents / ruby).
function isInlineElement(el: HTMLElement): boolean {
  if (el.tagName === "A") {
    let cached = inlineCache.get(el);
    if (cached === undefined) {
      try {
        cached = isInlineDisplay(window.getComputedStyle(el).display);
      } catch {
        cached = true;
      }
      inlineCache.set(el, cached);
    }
    return cached;
  }
  if (INLINE_TAGS.has(el.tagName)) return true;
  if (FORCE_BLOCK_TAGS.has(el.tagName)) return false;
  let cached = inlineCache.get(el);
  if (cached === undefined) {
    try {
      cached = isInlineDisplay(window.getComputedStyle(el).display);
    } catch {
      cached = false;
    }
    inlineCache.set(el, cached);
  }
  return cached;
}

// 元素自身/视觉隐藏 — 跳整子树 (V "肉眼可见全翻" 反义).
// display:none 子无 layout, visibility:hidden 子有占位但用户看不到.
function isHidden(el: HTMLElement): boolean {
  let cached = hiddenCache.get(el);
  if (cached === undefined) {
    try {
      const cs = window.getComputedStyle(el);
      cached = cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0";
    } catch {
      cached = false;
    }
    hiddenCache.set(el, cached);
  }
  return cached;
}

function isDisplayContentsElement(el: HTMLElement): boolean {
  try {
    return window.getComputedStyle(el).display.trim().toLowerCase() === "contents";
  } catch {
    return false;
  }
}

function isVisuallyHiddenElement(el: HTMLElement): boolean {
  const cls = el.className?.toString() || "";
  if (VISUALLY_HIDDEN_CLASS_RE.test(cls)) return true;
  try {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (cs.position === "absolute" || cs.position === "fixed")
      && rect.width <= 1
      && rect.height <= 1
      && (cs.overflow === "hidden" || cs.clip !== "auto" || cs.clipPath !== "none");
  } catch {
    return false;
  }
}

function isPageChromeElement(el: HTMLElement): boolean {
  const shell = el.closest(`header, footer, ${AUXILIARY_CONTENT_SELECTOR}`);
  if (shell instanceof HTMLElement && !shell.closest(MAIN_CONTENT_SELECTOR)) return true;
  return false;
}

function isIgnoredElement(el: HTMLElement): boolean {
  return !!el.closest(EXCLUDE_SELECTOR)
    || isVisuallyHiddenElement(el)
    || isPageChromeElement(el);
}

// el 的 *祖先* (不含 self) 已被标 leaf — 该 ancestor 已整段翻, 不该再切子树重复翻.
// 用 closest 物理 DOM 遍历, 不用内存 WeakSet. el 被 page 删, 探测自动失效.
function hasLeafAncestor(el: HTMLElement): boolean {
  return !!el.parentElement?.closest(`[${LEAF_ATTR}]`);
}

function closestLeafElement(el: HTMLElement): HTMLElement | null {
  const leaf = el.parentElement?.closest(`[${LEAF_ATTR}]`);
  if (leaf instanceof HTMLElement) return leaf;
  return el.hasAttribute(LEAF_ATTR) ? el : null;
}

function candidateRoot(el: HTMLElement): HTMLElement {
  return closestLeafElement(el) ?? el;
}

function isTranslationElement(el: HTMLElement): boolean {
  return el.classList.contains(TR_CLASS);
}

function isStayOriginalElement(el: HTMLElement): boolean {
  return STAY_ORIGINAL_TAGS.has(el.tagName)
    || el.matches(STAY_ORIGINAL_SELECTOR);
}

function isAtomicBlockElement(el: HTMLElement): boolean {
  return el.matches(ATOMIC_BLOCK_SELECTOR);
}

function isLargeMediaBox(width: number, height: number): boolean {
  return width >= RICH_MEDIA_MIN_EDGE_PX
    && height >= RICH_MEDIA_MIN_EDGE_PX
    && width * height >= RICH_MEDIA_MIN_AREA_PX;
}

function hasLargeVisualBox(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return isLargeMediaBox(rect.width, rect.height);
}

function hasNaturalMediaBox(el: HTMLElement): boolean {
  if (el instanceof HTMLImageElement) {
    return isLargeMediaBox(el.naturalWidth, el.naturalHeight);
  }
  if (el instanceof HTMLVideoElement) {
    return isLargeMediaBox(el.videoWidth, el.videoHeight);
  }
  if (el instanceof HTMLCanvasElement) {
    return isLargeMediaBox(el.width, el.height);
  }
  return false;
}

function hasMediaSource(el: HTMLElement): boolean {
  if (el instanceof HTMLImageElement) {
    return !!(el.currentSrc || el.src || el.getAttribute("src") || el.getAttribute("srcset"))
      || hasNaturalMediaBox(el);
  }
  if (el instanceof HTMLPictureElement) {
    return !!el.querySelector("img, source[srcset]");
  }
  if (el instanceof HTMLVideoElement) {
    return !!(el.currentSrc || el.src || el.poster || el.querySelector("source[src]"))
      || hasNaturalMediaBox(el);
  }
  if (el instanceof HTMLCanvasElement) {
    return el.width > 1 && el.height > 1;
  }
  if (el instanceof HTMLIFrameElement || el instanceof HTMLEmbedElement) {
    return !!(el.src || el.getAttribute("src"));
  }
  if (el instanceof HTMLObjectElement) {
    return !!el.data;
  }
  if (el.getAttribute("role") === "img") {
    return !!el.getAttribute("aria-label") || hasCssBackgroundImage(el);
  }
  return false;
}

function isBlockRenderedMedia(el: HTMLElement): boolean {
  try {
    const cs = window.getComputedStyle(el);
    return !isInlineDisplay(cs.display) || cs.position === "absolute" || cs.position === "fixed";
  } catch {
    return false;
  }
}

function hasCssBackgroundImage(el: HTMLElement): boolean {
  try {
    const bg = window.getComputedStyle(el).backgroundImage;
    return !!bg && bg !== "none";
  } catch {
    return false;
  }
}

function hasRichMediaSurface(el: HTMLElement): boolean {
  const mediaNodes = [el, ...Array.from(el.querySelectorAll(RICH_MEDIA_SELECTOR))];
  for (const node of mediaNodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (isTranslationElement(node) || isHidden(node)) continue;
    const isRenderedMedia = node.matches(RICH_MEDIA_SELECTOR) && isBlockRenderedMedia(node);
    if (node !== el && isRenderedMedia && (hasLargeVisualBox(el) || hasMediaSource(node))) {
      return true;
    }
    if (isRenderedMedia && hasNaturalMediaBox(node)) return true;
    if (node.matches(RICH_MEDIA_SELECTOR) && hasLargeVisualBox(node)) return true;
  }

  let scanned = 0;
  for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))]) {
    if (scanned++ >= RICH_MEDIA_SCAN_LIMIT) break;
    if (isTranslationElement(node) || isHidden(node)) continue;
    if (hasLargeVisualBox(node) && hasCssBackgroundImage(node)) return true;
  }
  return false;
}

function hasNonInlineElementChild(el: HTMLElement): boolean {
  for (const child of Array.from(el.children)) {
    if (child instanceof HTMLElement && !isInlineElement(child)) return true;
  }
  return false;
}

function hasTranslationChild(el: HTMLElement): boolean {
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (isTranslationElement(child) || child.querySelector(`.${TR_CLASS}`)) {
      return true;
    }
  }
  return false;
}

function hasTextBlockSemantics(el: HTMLElement): boolean {
  const dir = el.getAttribute("dir")?.toLowerCase();
  return !!el.getAttribute("lang") || dir === "auto";
}

// Read only the page's source text, never our injected sibling/wrapper text.
// This is the idempotency boundary: hash, language detection, trace text, and
// outbound LLM payload must all agree on the same source-only string.
function sourceText(el: HTMLElement): string {
  const parts: string[] = [];

  function pushBlockBreak() {
    if (parts.length === 0) return;
    const last = parts[parts.length - 1];
    if (!last.endsWith("\n")) parts.push("\n");
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (isTranslationElement(node)) return;
    if (node !== el && isStayOriginalElement(node)) {
      const text = node.textContent || "";
      if (text) parts.push(text);
      return;
    }
    if (node !== el) {
      if (isIgnoredElement(node)) return;
      if (!node.classList.contains(SRC_CLASS) && isHidden(node)) return;
    }
    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }

    const block = node !== el && FORCE_BLOCK_TAGS.has(node.tagName);
    if (block) pushBlockBreak();
    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
    if (block) pushBlockBreak();
  }

  for (const child of Array.from(el.childNodes)) {
    walk(child);
  }
  return parts.join("")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, (_match, offset, full: string) => {
      const before = full.slice(Math.max(0, offset - 24), offset).trim();
      return LINE_BREAK_ABBREVIATION_RE.test(before) ? " " : "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLeafTextElement(el: HTMLElement, knownHasRichMedia = hasRichMediaSurface(el)): boolean {
  if (knownHasRichMedia) return false;
  // 直接子节点必须全是 text 或 inline 元素 + 含可视 text.
  let hasMeaningfulText = false;
  const scan = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent || "").trim()) hasMeaningfulText = true;
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const childEl = node as HTMLElement;
    if (isTranslationElement(childEl) || childEl.querySelector(`.${TR_CLASS}`)) {
      return false;
    }
    if (isIgnoredElement(childEl) || isHidden(childEl)) return true;
    if (isDisplayContentsElement(childEl)) {
      for (const child of Array.from(childEl.childNodes)) {
        if (!scan(child)) return false;
      }
      return true;
    }
    if (!isInlineElement(childEl)) return false;
    if ((childEl.textContent || "").trim()) hasMeaningfulText = true;
    return true;
  };
  for (const child of Array.from(el.childNodes)) {
    if (!scan(child)) return false;
  }
  if (!hasMeaningfulText) return false;
  const text = sourceText(el);
  return shouldTranslate(text);
}

// "outer 含多个独立 inline 段 (子全 inline, inline 间无 text 桥接)"
// 例: X 推 <div tweetText><span>段1</span><span>段2</span></div> → multi
//     `<p>这段含 <a>链接</a> 文字</p>` → not multi (a 周围有 text 桥接)
function computeMultiSegmentInline(el: HTMLElement): boolean {
  let inlineCount = 0;
  let interText = false;
  let lastWasInlineElement = false;
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      if ((c.textContent || "").trim()) {
        if (lastWasInlineElement) interText = true;
      }
      lastWasInlineElement = false;
    } else if (c.nodeType === Node.ELEMENT_NODE) {
      const childEl = c as HTMLElement;
      if (isTranslationElement(childEl) || childEl.querySelector(`.${TR_CLASS}`)) return false;
      if (!isInlineElement(childEl)) return false;
      inlineCount++;
      lastWasInlineElement = true;
    }
  }
  return inlineCount >= 2 && !interText;
}

function isMultiSegmentInline(el: HTMLElement): boolean {
  let r = multiCache.get(el);
  if (r === undefined) {
    r = computeMultiSegmentInline(el);
    multiCache.set(el, r);
  }
  return r;
}

function collectTranslatable(root: ParentNode): HTMLElement[] {
  const result: HTMLElement[] = [];

  function visit(el: HTMLElement) {
    if (isIgnoredElement(el)) return;
    // 祖先已 leaf (整段已包翻) → 子树不切. 物理 closest 遍历, 不依赖内存 lock.
    if (hasLeafAncestor(el)) return;
    if (isHidden(el)) return;

    const isInline = isInlineElement(el);
    const containsTranslation = hasTranslationChild(el);

    if (el.shadowRoot) {
      registerShadowRoot(el.shadowRoot);
    }

    if (isInline) {
      // INLINE 标签自身仅在 leaf 时 ACCEPT (X 推 span / X article sibling 内容).
      // rich card / nested block 链接继续下钻, 避免 replace 模式隐藏媒体预览.
      const hasRichMedia = hasRichMediaSurface(el);
      if (!containsTranslation && isLeafTextElement(el, hasRichMedia)) {
        el.setAttribute(LEAF_ATTR, "1");
        result.push(el);
      }
      // 如果 inline parent 已含 babata 译文，不能把 parent 的原文+译文当
      // 一个新 leaf；下钻回原 source child，避免 X 上译文污染 hash。
      if (containsTranslation || hasRichMedia || hasNonInlineElementChild(el)) {
        for (const child of Array.from(el.children)) {
          if (child instanceof HTMLElement) visit(child);
        }
      }
      return;
    }

    if (!containsTranslation && isAtomicBlockElement(el)) {
      const text = sourceText(el);
      if (shouldTranslate(text, BLOCK_MIN_TEXT_COUNT)) {
        el.setAttribute(LEAF_ATTR, "1");
        result.push(el);
        return;
      }
    }

    // Natural-language containers with lang/dir=auto should stay one leaf even
    // when a site splits the sentence into many inline spans/mentions.
    if (!containsTranslation && hasTextBlockSemantics(el) && isLeafTextElement(el)) {
      el.setAttribute(LEAF_ATTR, "1");
      result.push(el);
      return;
    }

    // block 候选: 多 inline 子且无 text 桥接 → 拆开各翻.
    if (isMultiSegmentInline(el)) {
      // outer SKIP, walker 进子让 inline 各 ACCEPT.
      for (const child of Array.from(el.children)) {
        if (child instanceof HTMLElement) visit(child);
      }
      if (el.shadowRoot) {
        for (const child of Array.from(el.shadowRoot.children)) {
          if (child instanceof HTMLElement) visit(child);
        }
      }
      return;
    }

    // block 是单段 leaf → 整段一坨翻.
    if (isLeafTextElement(el)) {
      el.setAttribute(LEAF_ATTR, "1");
      result.push(el);
      return;
    }

    // block 但非 leaf (含 block 子) — 继续深入.
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) visit(child);
    }
    if (el.shadowRoot) {
      for (const child of Array.from(el.shadowRoot.children)) {
        if (child instanceof HTMLElement) visit(child);
      }
    }
  }

  if (root instanceof HTMLElement) {
    visit(root);
  } else {
    const children = root instanceof Document ? [document.body] : Array.from(root.children);
    for (const child of children) {
      if (child instanceof HTMLElement) visit(child);
    }
  }
  return result;
}

// ── language detection ────────────────────────────────────────────────

function detectLang(text: string): "zh" | "other" {
  let cn = 0;
  let total = 0;
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code < 0x20) continue;
    total++;
    if (code >= 0x4e00 && code <= 0x9fff) cn++;
  }
  if (total === 0) return "other";
  return cn / total > 0.3 ? "zh" : "other";
}

function shouldTranslate(text: string, minTextCount = DEFAULT_MIN_TEXT_COUNT): boolean {
  if (!text || text.length < minTextCount) return false;
  if (text.length > MAX_TRANSLATABLE_TEXT_COUNT) return false;
  // 输入框 placeholder / 示例文案常以 e.g. 开头。它们通常不是 DOM 正文文本,
  // 被页面用 overlay 渲染时强行注入会和原 placeholder 叠字；后续应走 attr 专用链.
  if (/^e\.g[.,]?\s+/i.test(text.trim())) return false;
  // X 上计数/倒计时会秒级 mutation；这些不是自然语言，翻译只会制造 stale_result
  // 和重复网络请求。保留含字母的混合文案，跳纯数字/时间/单位/handle/tag。
  const trimmed = text.trim();
  if (/^[@#][\p{L}\p{N}_-]+$/u.test(trimmed)) return false;
  // File trees and topic chips often expose lowercase identifiers as plain text
  // nodes. Translating "images", "docs", or "scrapling" damages the UI more
  // than it helps; sentence-like headings still pass this gate.
  if (/^[a-z0-9][a-z0-9._/-]{1,39}$/u.test(trimmed)) return false;
  if (!/[\p{L}]/u.test(text)) return false;
  if (/^[\d\s:.,，.%％+\-–—/()（）[\]万亿千百十kKmMbB]+$/u.test(text)) return false;
  return detectLang(text) !== "zh";
}

// ── hash (FNV-1a-ish 64bit, 16 hex chars) ─────────────────────────────

// X 反复 swap SPAN 时 textContent 含微妙空白差异 (trailing space / zero-width
// space / nbsp / 双空格) → 每次新 hash → cache miss → 反复调 server 翻不同译文 →
// V 视觉"反复变". 实测 "Hello..." 5 种空白形式 → 5 完全不同 hash. normalize:
//   ZWSP (U+200B-200F) / BOM (U+FEFF) / nbsp (U+00A0) → ASCII space
//   多空白 → 单 space, 头尾 strip.
// 同英文 text 不同空白形式同 hash, cache 100% 命中.
function normalizeForHash(text: string): string {
  return text
    .replace(/[​-‏﻿ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text: string, target: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  const s = text + "|" + target;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x100000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

// ── selection translation popup ────────────────────────────────────────

type SelectionPopupState = "loading" | "ready" | "error";

interface SelectionSnapshot {
  text: string;
  rect: DOMRect;
}

interface SelectionPopup {
  host: HTMLDivElement;
  panel: HTMLDivElement;
  status: HTMLDivElement;
  body: HTMLDivElement;
}

function selectableText(): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
  return sel.toString()
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .trim()
    .slice(0, SELECTION_MAX_TEXT + 1);
}

function selectionRect(sel: Selection): DOMRect | null {
  if (sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const rects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length > 0) return rects[rects.length - 1];
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return rect;
  return null;
}

function currentSelectionSnapshot(): SelectionSnapshot | null {
  if (!selectionTranslationEnabled) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = selectableText();
  if (!text || text.length > SELECTION_MAX_TEXT || !shouldTranslate(text)) return null;
  const rect = selectionRect(sel);
  if (!rect) return null;
  return { text, rect };
}

function createSelectionPopup(): SelectionPopup {
  const host = document.createElement("div");
  host.setAttribute("data-bbt-selection-popup", "1");
  host.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "top:0",
    "left:0",
    "width:0",
    "height:0",
    "pointer-events:none",
  ].join(";");
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .panel {
      box-sizing: border-box;
      width: min(${SELECTION_POPUP_WIDTH}px, calc(100vw - 24px));
      max-height: ${SELECTION_POPUP_MAX_HEIGHT}px;
      overflow: auto;
      pointer-events: auto;
      color: #1f1f1f;
      background: rgba(255, 255, 255, .98);
      border: 1px solid rgba(28, 25, 23, .12);
      border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 3px 12px rgba(0,0,0,.08);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 10px 12px 11px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .panel[hidden] { display: none !important; }
    .status {
      color: #78716c;
      font-size: 12px;
      line-height: 1.3;
      margin-bottom: 5px;
      user-select: none;
    }
    .body { color: #222; }
    .panel[data-state="error"] .status { color: #b42318; }
    .panel[data-state="loading"] .body { color: #78716c; }
  `;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");

  const status = document.createElement("div");
  status.className = "status";
  const body = document.createElement("div");
  body.className = "body";
  panel.append(status, body);
  root.append(style, panel);

  root.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener("click", (event) => event.stopPropagation());

  (document.documentElement || document.body).appendChild(host);
  return { host, panel, status, body };
}

function positionSelectionPopup(host: HTMLElement, rect: DOMRect) {
  const margin = 8;
  const gap = 9;
  const width = Math.min(SELECTION_POPUP_WIDTH, window.innerWidth - margin * 2);
  const estimatedHeight = Math.min(SELECTION_POPUP_MAX_HEIGHT, Math.max(120, window.innerHeight * 0.28));
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  let top = rect.bottom + gap;
  if (top + estimatedHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - estimatedHeight - gap);
  }
  host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function renderSelectionPopup(
  popup: SelectionPopup,
  state: SelectionPopupState,
  text: string,
) {
  popup.panel.hidden = false;
  popup.panel.dataset.state = state;
  popup.status.textContent = state === "loading"
    ? "babata 正在翻译"
    : state === "error"
      ? "翻译失败"
      : "babata";
  popup.body.textContent = text;
}

function hideSelectionPopup(popup: SelectionPopup) {
  popup.panel.hidden = true;
  popup.body.textContent = "";
}

async function translateSelectionText(text: string): Promise<string | null> {
  if (!selectionTranslationEnabled) return null;
  const hash = hashText(normalizeForHash(text), TARGET_LANG);
  const cached = cache.get(hash);
  if (cached) return cached;
  const resp = (await safeChromeSend(() =>
    chrome.runtime.sendMessage({
      type: "babata.translate",
      site: location.hostname,
      url: location.href,
      target: TARGET_LANG,
      batch: [{ hash, text }],
    }),
  )) as { ok: boolean; results?: { hash: string; translated: string }[] } | undefined;
  const translated = resp?.ok
    ? resp.results?.find((item) => item.hash === hash)?.translated?.trim()
    : "";
  if (!translated) return null;
  cache.set(hash, translated);
  return translated;
}

function setupSelectionTranslator() {
  const popup = createSelectionPopup();
  let timer: number | null = null;
  let requestSeq = 0;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay = SELECTION_DEBOUNCE_MS) {
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      void showForSelection();
    }, delay);
  }

  async function showForSelection() {
    const snapshot = currentSelectionSnapshot();
    if (!snapshot) {
      hideSelectionPopup(popup);
      return;
    }

    const seq = ++requestSeq;
    positionSelectionPopup(popup.host, snapshot.rect);
    renderSelectionPopup(popup, "loading", "…");
    const translated = await translateSelectionText(snapshot.text);
    if (seq !== requestSeq) return;
    if (!translated) {
      renderSelectionPopup(popup, "error", "没有拿到译文，稍后再试。");
      return;
    }
    renderSelectionPopup(popup, "ready", translated);
  }

  function hideAndInvalidate() {
    requestSeq++;
    clearTimer();
    hideSelectionPopup(popup);
  }

  const onSelectionChange = () => schedule();
  const onPointerUp = (event: MouseEvent | TouchEvent) => {
    if (event instanceof MouseEvent && event.button === 2) return;
    schedule(120);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      hideAndInvalidate();
      return;
    }
    schedule(120);
  };
  const onPointerDown = (event: MouseEvent | TouchEvent) => {
    const path = event.composedPath();
    if (path.includes(popup.host)) return;
    hideAndInvalidate();
  };
  const onScrollOrResize = () => hideAndInvalidate();
  const onSelectionSettingChanged = () => {
    if (selectionTranslationEnabled) {
      schedule(80);
    } else {
      hideAndInvalidate();
    }
  };

  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("mouseup", onPointerUp);
  window.addEventListener("touchend", onPointerUp);
  window.addEventListener("keyup", onKeyUp);
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("touchstart", onPointerDown, true);
  document.addEventListener(SELECTION_SETTING_EVENT, onSelectionSettingChanged);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);

  registerCleanup(() => {
    hideAndInvalidate();
    document.removeEventListener("selectionchange", onSelectionChange);
    window.removeEventListener("mouseup", onPointerUp);
    window.removeEventListener("touchend", onPointerUp);
    window.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("touchstart", onPointerDown, true);
    document.removeEventListener(SELECTION_SETTING_EVENT, onSelectionSettingChanged);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    popup.host.remove();
  });
}

// ── inject ────────────────────────────────────────────────────────────

function clearTranslation(el: HTMLElement) {
  el.querySelectorAll(`:scope .${TR_INPLACE_CLASS}`).forEach((node) => node.remove());
  const next = el.nextElementSibling;
  if (next && next.classList.contains(TR_CLASS)) {
    next.remove();
  }
}

function clearCandidateState(el: HTMLElement) {
  clearTranslation(el);
  el.removeAttribute(HASH_ATTR);
  el.removeAttribute(LEAF_ATTR);
  el.removeAttribute(INPLACE_ATTR);
  stableWindowMap.delete(el);
  inFlightElements.delete(el);
  io?.unobserve(el);
}

function clearAllTranslations() {
  for (const root of translationRoots()) {
    root.querySelectorAll(`.${TR_CLASS}`).forEach((node) => node.remove());
  }
}

function isElementNearViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom >= -VISIBLE_PRIORITY_MARGIN_PX
    && rect.top <= window.innerHeight + VISIBLE_PRIORITY_MARGIN_PX
    && rect.right >= -VISIBLE_PRIORITY_MARGIN_PX
    && rect.left <= window.innerWidth + VISIBLE_PRIORITY_MARGIN_PX;
}

function shouldCopyNativeAttr(el: HTMLElement, name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "id" || lower.startsWith("data-bbt-")) return false;
  if (lower.startsWith("on")) return false;
  if (lower === "class" || lower === "style" || lower === "dir" || lower === "title") {
    return true;
  }
  if (lower === "role" || lower === "tabindex") return true;
  if (lower.startsWith("data-")) return true;
  if ([
    "aria-current",
    "aria-selected",
    "aria-disabled",
    "aria-expanded",
    "aria-pressed",
    "aria-checked",
  ].includes(lower)) {
    return true;
  }
  if (el.tagName === "A") {
    return ["href", "target", "rel", "download", "referrerpolicy"].includes(lower);
  }
  return false;
}

const UNSAFE_NATIVE_REPLACE_TAGS = new Set([
  "AUDIO", "BR", "BUTTON", "CANVAS", "IFRAME", "IMG", "INPUT", "MATH",
  "OPTION", "PICTURE", "SCRIPT", "SELECT", "SOURCE", "STYLE", "SVG",
  "TEMPLATE", "TEXTAREA", "VIDEO", "WBR",
]);

const INPLACE_UI_CONTEXT_SELECTOR = [
  "a[href]",
  "button",
  "nav",
  "aside",
  "header",
  "footer",
  "form",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="dialog"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="navigation"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="tablist"]',
].join(", ");

const INPLACE_TEXT_TAGS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6", "LABEL", "LEGEND", "SUMMARY", "DT", "DD", "TH", "TD",
]);

const CUSTOM_TEXT_SHELL_ID_RE = /(?:^|[-_])(text|title|content|description|snippet|body|message)(?:$|[-_])/i;

const PRESERVED_SOURCE_SHELL_SELECTOR = [
  "svg", "img", "canvas", "video", "audio", "picture", "input", "textarea", "select",
  "button", "a[href]", '[role="button"]', '[role="link"]', '[role="menuitem"]',
  '[role="option"]', '[role="tab"]',
].join(", ");

function directInplaceTranslation(el: HTMLElement): Element | null {
  return el.querySelector(`:scope .${TR_INPLACE_CLASS}`);
}

function hasInjectedTranslation(el: HTMLElement): boolean {
  const next = el.nextElementSibling;
  return !!directInplaceTranslation(el) || !!(next && next.classList.contains(TR_CLASS));
}

function hasLayoutDisplay(el: HTMLElement): boolean {
  try {
    const display = window.getComputedStyle(el).display;
    return display.includes("flex") || display.includes("grid");
  } catch {
    return false;
  }
}

function shouldRenderInPlace(el: HTMLElement, text: string): boolean {
  if (mode !== "replace") return false;
  if (shouldPreserveCustomTextShell(el, text)) return true;
  if (text.length > 180) return false;
  // 文章正文/推文仍走 sibling, 避免 React 高频 reconcile 抢子树.
  if (el.closest("article, [role='article']")) return false;
  if (INPLACE_TEXT_TAGS.has(el.tagName)) return true;
  if (el.closest(INPLACE_UI_CONTEXT_SELECTOR)) return true;
  if (text.length > 120) return false;
  if (hasLayoutDisplay(el)) return true;
  if (el.parentElement && hasLayoutDisplay(el.parentElement)) return true;
  return false;
}

function shouldPreserveCustomTextShell(el: HTMLElement, text: string): boolean {
  if (!el.tagName.includes("-")) return false;
  if (text.length > CUSTOM_TEXT_SHELL_INPLACE_MAX_TEXT) return false;
  if (hasRichMediaSurface(el)) return false;
  if (hasTextBlockSemantics(el)) return true;
  return !!el.id && CUSTOM_TEXT_SHELL_ID_RE.test(el.id);
}

function hasPreservedSourceShell(el: HTMLElement): boolean {
  return el.matches(PRESERVED_SOURCE_SHELL_SELECTOR)
    || !!el.querySelector(PRESERVED_SOURCE_SHELL_SELECTOR);
}

function firstSourceTemplateClass(el: HTMLElement): HTMLElement | null {
  const existing = el.querySelector(`:scope .${SRC_CLASS}`);
  return existing instanceof HTMLElement ? existing : null;
}

function markInPlaceSource(el: HTMLElement): HTMLElement | null {
  let template: HTMLElement | null = firstSourceTemplateClass(el);

  function markNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!(node.textContent || "").trim()) return;
      const wrapper = document.createElement("span");
      wrapper.className = SRC_CLASS;
      node.parentNode?.insertBefore(wrapper, node);
      wrapper.appendChild(node);
      skipMoNodes.add(wrapper);
      if (!template) template = wrapper;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (isTranslationElement(node)) return;
    if (isIgnoredElement(node)) return;
    if (!node.classList.contains(SRC_CLASS) && isHidden(node)) return;
    if (node.classList.contains(SRC_CLASS)) {
      if (!template) template = node;
      return;
    }
    if (!sourceText(node)) return;

    // Composite controls often contain an icon plus a text span. Hide only the
    // source text descendants so the button/link shell and icon stay intact.
    if (hasPreservedSourceShell(node)) {
      for (const child of Array.from(node.childNodes)) markNode(child);
      return;
    }

    node.classList.add(SRC_CLASS);
    if (!template) template = node;
  }

  for (const child of Array.from(el.childNodes)) {
    markNode(child);
  }
  return template;
}

function copyTextPresentation(src: HTMLElement | null, dst: HTMLElement) {
  if (!src) return;
  const classes = Array.from(src.classList)
    .filter((name) => name !== SRC_CLASS && !name.startsWith("bbt-"));
  if (classes.length) dst.className = classes.join(" ");
  const style = src.getAttribute("style");
  if (style) dst.setAttribute("style", style);
  const dir = src.getAttribute("dir");
  if (dir) dst.setAttribute("dir", dir);
}

function createNativeTranslationElement(el: HTMLElement, inlineLeaf: boolean): HTMLElement {
  const tag = el.tagName;
  const useNativeTag = !UNSAFE_NATIVE_REPLACE_TAGS.has(tag) && !tag.includes("-");
  const node = document.createElement(
    useNativeTag ? tag.toLowerCase() : inlineLeaf ? "span" : "div",
  );
  for (const attr of Array.from(el.attributes)) {
    if (shouldCopyNativeAttr(el, attr.name)) {
      node.setAttribute(attr.name, attr.value);
    }
  }
  node.classList.add(TR_CLASS, inlineLeaf ? TR_INLINE_CLASS : TR_BLOCK_CLASS, TR_NATIVE_CLASS);
  node.setAttribute("lang", TARGET_LANG);
  return node;
}

function createInPlaceTranslationElement(template: HTMLElement | null, safe: string): HTMLElement {
  const node = document.createElement("span");
  copyTextPresentation(template, node);
  node.classList.add(TR_CLASS, TR_INLINE_CLASS, TR_NATIVE_CLASS, TR_INPLACE_CLASS);
  node.setAttribute("lang", TARGET_LANG);
  Reflect.set(node, "innerHTML", safe);
  return node;
}

function createTranslationElement(el: HTMLElement, safe: string, inlineLeaf: boolean): HTMLElement {
  if (mode === "replace") {
    const node = createNativeTranslationElement(el, inlineLeaf);
    Reflect.set(node, "innerHTML", safe);
    return node;
  }

  const font = document.createElement("font");
  // marker class 让 CSS 区分 inline-leaf (流畅 inline) vs block-leaf (占行 block).
  // 装饰 (border / 字号 / 间距) 在 CSS rule 里按 mode 控制, 不再 inline style.
  font.className = TR_CLASS + " " + (inlineLeaf ? TR_INLINE_CLASS : TR_BLOCK_CLASS);
  Reflect.set(font, "innerHTML", safe);
  return font;
}

interface SourceLink {
  source: HTMLAnchorElement;
  tokens: string[];
  used: boolean;
}

function collapsedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function addLinkToken(tokens: string[], value: string | null | undefined) {
  const text = collapsedText(value ?? "");
  if (text.length < 2 || tokens.includes(text)) return;
  tokens.push(text);
}

function addUrlLikeTokens(tokens: string[], value: string | null | undefined) {
  const text = collapsedText(value ?? "");
  if (!text) return;
  addLinkToken(tokens, text);
  const withoutProtocol = text.replace(/^https?:\/\//i, "");
  addLinkToken(tokens, withoutProtocol);
  addLinkToken(tokens, withoutProtocol.replace(/^www\./i, ""));
  if (withoutProtocol.endsWith("/")) {
    addLinkToken(tokens, withoutProtocol.slice(0, -1));
  } else if (/\.[a-z]{2,}(?:[/:?#]|$)/i.test(withoutProtocol)) {
    addLinkToken(tokens, `${withoutProtocol}/`);
  }
}

function collectSourceLinks(el: HTMLElement): SourceLink[] {
  const links: SourceLink[] = [];
  for (const source of Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (isIgnoredElement(source) || isTranslationElement(source)) continue;
    const href = source.getAttribute("href") || "";
    const tokens: string[] = [];
    const visibleTexts = [sourceText(source), source.innerText, source.textContent ?? ""];
    for (const visibleText of visibleTexts) {
      addLinkToken(tokens, visibleText);
      addUrlLikeTokens(tokens, visibleText);
    }
    addUrlLikeTokens(tokens, href);
    addUrlLikeTokens(tokens, source.href);
    if (tokens.length === 0) continue;
    tokens.sort((a, b) => b.length - a.length);
    links.push({ source, tokens, used: false });
  }
  return links;
}

function copyAnchorAttrs(src: HTMLAnchorElement, dst: HTMLAnchorElement) {
  for (const attr of Array.from(src.attributes)) {
    if (["href", "title", "class", "target", "rel", "referrerpolicy"].includes(attr.name.toLowerCase())) {
      dst.setAttribute(attr.name, attr.value);
    }
  }
  if (dst.target === "_blank" && !dst.rel) dst.rel = "noopener noreferrer";
}

function tokenIndexOf(text: string, token: string, start: number): number {
  if (/\.[a-z]{2,}(?:[/:?#]|$)|^https?:\/\//i.test(token)) {
    return text.toLowerCase().indexOf(token.toLowerCase(), start);
  }
  return text.indexOf(token, start);
}

function nextSourceLinkMatch(
  text: string,
  links: SourceLink[],
  start: number,
): { index: number; token: string; link: SourceLink } | null {
  let best: { index: number; token: string; link: SourceLink } | null = null;
  for (const link of links) {
    if (link.used) continue;
    for (const token of link.tokens) {
      const index = tokenIndexOf(text, token, start);
      if (index === -1) continue;
      if (
        !best
        || index < best.index
        || (index === best.index && token.length > best.token.length)
      ) {
        best = { index, token, link };
      }
    }
  }
  return best;
}

function linkifyPreservedSourceLinks(el: HTMLElement, safe: string): string {
  const links = collectSourceLinks(el);
  if (links.length === 0) return safe;

  const template = document.createElement("template");
  Reflect.set(template, "innerHTML", safe);
  const walker = document.createTreeWalker(
    template.content,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        return parent && parent.closest("a")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text) textNodes.push(walker.currentNode);
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    if (!text) continue;
    let offset = 0;
    let match = nextSourceLinkMatch(text, links, offset);
    if (!match) continue;

    const frag = document.createDocumentFragment();
    while (match) {
      if (match.index > offset) {
        frag.append(document.createTextNode(text.slice(offset, match.index)));
      }
      const matchedText = text.slice(match.index, match.index + match.token.length);
      const a = document.createElement("a");
      copyAnchorAttrs(match.link.source, a);
      a.textContent = matchedText;
      frag.append(a);
      match.link.used = true;
      offset = match.index + match.token.length;
      match = nextSourceLinkMatch(text, links, offset);
    }
    if (offset < text.length) {
      frag.append(document.createTextNode(text.slice(offset)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  return DOMPurify.sanitize(template.innerHTML, SAFE_HTML_OPTS);
}

function injectTranslation(el: HTMLElement, raw: string, hash?: string) {
  clearTranslation(el);
  if (mode === "off" || !raw) return;
  // 译文等于原文 (模型决定不翻 — 专有名词 / handle / 版本号等) → 不 inject sibling,
  // 否则视觉上原文显示 2 遍 (V 截图 #8 user info 重复 3 次的 root cause).
  const original = sourceText(el);
  if (raw.trim() === original) return;
  // server 返 plain text with \n\n 段分隔. 浏览器把 \n 当 whitespace 渲染,
  // 段间会粘连, 转 <br><br> 才有视觉换行 (DOMPurify allowlist 含 br).
  const withBreaks = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
  const safe = linkifyPreservedSourceLinks(el, DOMPurify.sanitize(withBreaks, SAFE_HTML_OPTS));
  const inlineLeaf = isInlineElement(el);
  if (shouldRenderInPlace(el, original)) {
    const template = markInPlaceSource(el);
    const tr = createInPlaceTranslationElement(template, safe);
    skipMoNodes.add(tr);
    el.setAttribute(INPLACE_ATTR, "1");
    if (template) {
      template.insertAdjacentElement("afterend", tr);
    } else {
      el.appendChild(tr);
    }
    if (hash) recentlyInjected.set(hash, Date.now());
    return;
  }
  const tr = createTranslationElement(el, safe, inlineLeaf);
  // MO sentinel: 自己 inject 的 node 加进 skipMoNodes, MO addedNodes 看到跳 (防自触发).
  skipMoNodes.add(tr);
  // sibling 注入 — 5 源共识 (kiss translator.js:1359 .after / 沉浸式 Zs insertBefore /
  // read-frog page-translation.ts insertBefore / old-immersive). 防死循环靠"不处理
  // removedNodes" (F6 已删), 不靠 appendChild 进 leaf. appendChild 实测在 X 上 React
  // 仍 swap 整 SPAN, 加上 getComputedStyle reflow = 整页 layout thrashing 闪.
  el.insertAdjacentElement("afterend", tr);
  if (hash) recentlyInjected.set(hash, Date.now());
}

function rerenderCachedTranslations() {
  clearAllTranslations();
  recentlyInjected.clear();
  if (mode === "off") return;
  for (const root of translationRoots()) {
    root.querySelectorAll(`[${HASH_ATTR}]`).forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const text = sourceText(node);
      if (!shouldTranslate(text)) return;
      const fresh = hashText(normalizeForHash(text), TARGET_LANG);
      const translated = cache.get(fresh);
      if (translated !== undefined) {
        node.setAttribute(HASH_ATTR, fresh);
        injectTranslation(node, translated, fresh);
        return;
      }
      processCandidate(node, "rerun");
    });
  }
}

// ── candidate processing ──────────────────────────────────────────────

function processCandidate(el: HTMLElement, src: TraceSource = "init") {
  if (mode === "off") return;
  el = candidateRoot(el);

  // user-initiated (rerun = mode toggle / init = boot) 立即处理, 不等 stable window.
  // mutation-triggered (io / mo_add / mo_char) 走 trailing stable-window: 每次 mutation
  // 更新 ts, 1100ms 静默后才真 process — 拿到 X reconcile 稳态 text 1 次翻不闪.
  if (src === "rerun" || src === "init") {
    doProcessCandidate(el, src);
    return;
  }
  // 已在 in-flight 翻译中: 不重 enqueue, flush 完成后下次 mutation 再触发.
  if (inFlightElements.has(el)) {
    trace(src, el, "", "in_flight_defer");
    return;
  }
  // 入 trailing stable-window — 每次 mutation 更新 ts. last-wins.
  stableWindowMap.set(el, { ts: Date.now(), src });
  trace(src, el, "", "stable_pending");
}

function doProcessCandidate(el: HTMLElement, src: TraceSource) {
  const hasInjected = hasInjectedTranslation(el);
  if (isIgnoredElement(el)) {
    clearCandidateState(el);
    trace(src, el, "", "not_translatable", "");
    return;
  }
  if (hasRichMediaSurface(el)) {
    clearCandidateState(el);
    trace(src, el, "", "not_translatable", sourceText(el));
    observeNew(el, src);
    return;
  }
  if (!hasInjected && isHidden(el)) {
    clearCandidateState(el);
    trace(src, el, "", "not_translatable", "");
    return;
  }

  const text = sourceText(el);
  if (!text) {
    trace(src, el, "", "skip_no_text");
    return;
  }
  if (!shouldTranslate(text)) {
    trace(src, el, "", "not_translatable", text);
    return;
  }

  const fresh = hashText(normalizeForHash(text), TARGET_LANG);
  const existing = el.getAttribute(HASH_ATTR);

  // SPA 重 mount 时, 旧 .bbt-tr sibling 可能跟随 hash 节点带过来; 但 text 已变 →
  // hash 不一致 → 旧译文跟新内容不对应, 必须清掉重翻.
  if (hasInjected && existing === fresh) {
    trace(src, el, fresh, "already", text);
    return;
  }
  if (hasInjected && existing !== fresh) {
    clearTranslation(el);
  }

  // 同 hash 全 page 共享 1500ms debounce — 防不同 element 同 text 短时间反复 inject.
  const recentTs = recentlyInjected.get(fresh);
  if (recentTs !== undefined && Date.now() - recentTs < INJECT_DEBOUNCE_MS) {
    trace(src, el, fresh, "debounce", text);
    return;
  }

  if (existing !== fresh) {
    el.setAttribute(HASH_ATTR, fresh);
  }

  const cached = cache.get(fresh);
  if (cached !== undefined) {
    trace(src, el, fresh, "cache_inject", text);
    injectTranslation(el, cached, fresh);
    return;
  }

  // hash in-flight: 同 text 跨 element instance 已 enqueue 在 server roundtrip 中,
  // 不重 enqueue 触发并发 flush. 等 flush 完 cache.set 后, 同 hash 走 cache hit.
  if (inFlightHashes.has(fresh)) {
    trace(src, el, fresh, "in_flight_defer", text);
    return;
  }

  trace(src, el, fresh, "enqueue", text);
  inFlightElements.add(el);
  inFlightHashes.add(fresh);
  queue.set(fresh, {
    el,
    text,
    visible: isElementNearViewport(el),
    attempts: 0,
  });
  // queue cap — V 快速滚时 evict 最老 (FIFO insertion order).
  if (queue.size > QUEUE_MAX) {
    const oldest = queue.keys().next().value as string | undefined;
    if (oldest && oldest !== fresh) {
      const evicted = queue.get(oldest);
      queue.delete(oldest);
      inFlightHashes.delete(oldest);
      if (evicted) inFlightElements.delete(evicted.el);
    }
  }
  scheduleFlush();
}

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS) {
  if (flushInProgress) return;
  if (flushTimer !== null) return;
  const backoffMs = Math.max(0, nextFlushNotBefore - Date.now());
  flushTimer = window.setTimeout(flush, Math.max(delayMs, backoffMs));
}

async function flush() {
  flushTimer = null;
  if (flushInProgress) {
    scheduleFlush();
    return;
  }
  if (queue.size === 0) return;
  flushInProgress = true;
  try {
    await flushOnce();
  } finally {
    flushInProgress = false;
    if (queue.size > 0) scheduleFlush();
  }
}

async function flushOnce() {
  // 可见优先取 BATCH_SIZE, 但不丢 scroll-out: 队列里的后台段落继续补翻.
  // slice 暂不删, 等 round-trip 完按 result 状态决定.
  const slice: { hash: string; el: HTMLElement; text: string }[] = [];
  const candidates = Array.from(queue.entries()).sort((a, b) => {
    const av = a[1].visible || isElementNearViewport(a[1].el);
    const bv = b[1].visible || isElementNearViewport(b[1].el);
    if (av !== bv) return bv ? 1 : -1;
    return a[1].attempts - b[1].attempts;
  });
  for (const [h, item] of candidates) {
    item.visible = item.visible || isElementNearViewport(item.el);
    slice.push({ hash: h, el: item.el, text: item.text });
    if (slice.length >= BATCH_SIZE) break;
  }
  if (slice.length === 0) return;

  const batch = slice.map(({ hash, text }) => ({
    hash,
    text,
  }));

  let results: { hash: string; translated: string }[] = [];
  let networkOk = false;
  const resp = (await safeChromeSend(() =>
    chrome.runtime.sendMessage({
      type: "babata.translate",
      site: location.hostname,
      url: location.href,
      target: TARGET_LANG,
      batch,
    }),
  )) as { ok: boolean; results?: typeof results } | undefined;
  if (resp?.ok && Array.isArray(resp.results)) {
    results = resp.results;
    networkOk = true;
    transportFailures = 0;
    nextFlushNotBefore = 0;
  }
  // SW / server 没 ready 或 extension reload → bounded retry with backoff. The old
  // 300ms loop hammered localhost indefinitely when the server was down.
  if (!networkOk) {
    transportFailures += 1;
    const retryDelay = Math.min(
      TRANSPORT_RETRY_BASE_MS * Math.pow(2, Math.max(0, transportFailures - 1)),
      TRANSPORT_RETRY_MAX_MS,
    );
    nextFlushNotBefore = Date.now() + retryDelay;
    for (const { hash, el, text } of slice) {
      const queued = queue.get(hash);
      if (!queued) continue;
      queued.attempts += 1;
      if (queued.attempts > TRANSPORT_MAX_RETRIES) {
        trace("mo_add", el, hash, "transport_drop", text);
        queue.delete(hash);
      } else {
        queued.visible = queued.visible || isElementNearViewport(el);
        trace("mo_add", el, hash, "transport_retry", text);
      }
    }
  }

  const byHash = new Map(slice.map((item) => [item.hash, item]));
  const staleRechecks: HTMLElement[] = [];
  const completedHashes = new Set<string>();
  for (const r of results) {
    const item = byHash.get(r.hash);
    if (!item || !r.translated) continue;
    completedHashes.add(r.hash);
    cache.set(r.hash, r.translated);
    const currentText = sourceText(item.el);
    const currentHash = currentText ? hashText(normalizeForHash(currentText), TARGET_LANG) : "";
    if (currentHash !== r.hash) {
      trace("mo_add", item.el, r.hash, "stale_result", currentText);
      staleRechecks.push(item.el);
      continue;
    }
    injectTranslation(item.el, r.translated, r.hash);
  }

  if (networkOk) {
    for (const { hash, el, text } of slice) {
      if (completedHashes.has(hash)) {
        queue.delete(hash);
        continue;
      }
      const queued = queue.get(hash);
      if (!queued) continue;
      queued.attempts += 1;
      if (queued.attempts > MISSING_RESULT_MAX_RETRIES) {
        trace("mo_add", el, hash, "missing_result_drop", text);
        queue.delete(hash);
      } else {
        queued.visible = queued.visible || isElementNearViewport(el);
        trace("mo_add", el, hash, "missing_result_retry", text);
      }
    }
  }
  // 不管 networkOk 与否, slice 里 element / hash 释放 in-flight 锁.
  for (const { el } of slice) inFlightElements.delete(el);
  for (const { hash } of slice) inFlightHashes.delete(hash);
  for (const el of staleRechecks) {
    if (el.isConnected) processCandidate(el, "mo_add");
  }
}

// ── observers ─────────────────────────────────────────────────────────

let io: IntersectionObserver | null = null;

function makeIO() {
  // IO 追踪 visibleHashes + 提升队列优先级. 翻译不 gate 在 viewport:
  // 可见段先翻, scroll-out 段后台补完.
  io = new IntersectionObserver(
    (entries) => {
      let viewportChanged = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const h = el.getAttribute(HASH_ATTR);
        if (!h) continue;
        if (e.isIntersecting) {
          const queued = queue.get(h);
          if (queued) queued.visible = true;
          if (!visibleHashes.has(h)) {
            visibleHashes.add(h);
            viewportChanged = true;
          }
        } else {
          if (visibleHashes.delete(h)) {
            viewportChanged = true;
          }
        }
      }
      if (viewportChanged) scheduleViewportPush();
    },
    { rootMargin: `${VISIBLE_PRIORITY_MARGIN_PX}px`, threshold: 0.01 },
  );
}

function observeNew(root: ParentNode, src: TraceSource = "init") {
  if (!io) return;
  // 通用 leaf-text 收集 (不再走 site-specific selectors).
  const elements = collectTranslatable(root);
  for (const el of elements) {
    io.observe(el);
    processCandidate(el, src);
  }
}

function observeMutations(root: ParentNode = document.body) {
  if (mo === null) {
    mo = new MutationObserver((records) => {
      for (const r of records) {
        // F7 codex: kiss translator.js:711-714 完整 sentinel — 跳 mutation.target 是
        // .bbt-tr font 自己 / 已 inside .bbt-tr 的 mutation. X reconcile burst 期间
        // 我们 sibling .bbt-tr 内部也可能被 X 触发 mutation (即使我们没动它).
        const target = r.target;
        if (target instanceof HTMLElement) {
          if (target.classList.contains(TR_CLASS)) continue;
          if (target.closest && target.closest(`.${TR_CLASS}`)) continue;
        }
        // class/style/hidden 变化能让原本 display:none 的段落变可见. hiddenCache /
        // inlineCache 都基于 computed style, 属性变更时必须失效并重新 collect.
        if (r.type === "attributes") {
          if (target instanceof HTMLElement) {
            hiddenCache.delete(target);
            inlineCache.delete(target);
            multiCache.delete(target);
            const leaf = closestLeafElement(target);
            if (leaf) processCandidate(leaf, "mo_add");
            observeNew(target, "mo_add");
          }
          continue;
        }
        // F-V-display-more: X "显示更多" 点开后, X 用 React 替换 tweetText nodeValue
        // (characterData mutation 不是 childList). 抄 kiss translator.js:718-723 模式:
        // oldValue !== nodeValue 才触发 (filter noop), processCandidate parent 重 enqueue.
        if (r.type === "characterData") {
          if (r.oldValue === r.target.nodeValue) continue;
          const parent = r.target.parentElement;
          if (parent && parent instanceof HTMLElement) {
            // 父元素 inside .bbt-tr 跳 (我们译文 text node 改不算用户内容变化).
            if (parent.closest && parent.closest(`.${TR_CLASS}`)) continue;
            processCandidate(parent, "mo_char");
          }
          continue;
        }
        // childList mutation: X "显示更多" 可能替换 tweetText 的内层 span，而不是
        // 直接改 leaf root。mutation 入口必须回到最近的 leaf 根节点，否则会把子 span
        // 当新段落翻译，旧整段译文仍留在旁边，展开后原文/译文混排。
        if (target instanceof HTMLElement) {
          const leaf = closestLeafElement(target);
          if (leaf) processCandidate(leaf, "mo_add");
        }

        for (const node of r.addedNodes) {
          // 自己 inject 的 .bbt-tr font 跳 (kiss translator.js:711 同模式) — 防自触发 loop.
          if (skipMoNodes.has(node)) continue;
          // 结构性 sentinel: addedNode 自己是 .bbt-tr (即使 skipMoNodes WeakSet 没 cover —
          // 比如 SPA clone / 第三方扩展插同 class 元素) 跳 (kiss translator.js:730-732).
          if (node instanceof HTMLElement && node.classList.contains(TR_CLASS)) continue;
          if (!(node instanceof HTMLElement)) continue;

          // 重 mount 的原段落带 hash → 立即 L1 cache 命中 re-inject.
          if (node.hasAttribute(HASH_ATTR)) {
            processCandidate(node, "mo_add");
          }
          const hashed = node.querySelectorAll(`[${HASH_ATTR}]`);
          for (const h of hashed) {
            if (h instanceof HTMLElement) processCandidate(h, "mo_add");
          }

          // 新加段落 → 加入 IO 观察 (viewport 入境再翻).
          observeNew(node, "mo_add");
        }

        // 故意不处理 r.removedNodes — 5 源对照 (agent 反编译铁证):
        //   kiss translator.js:707-749 / read-frog page-translation.ts:516-532 /
        //   old-immersive pageTranslator.js:284 全部 only addedNodes 不动 removedNodes;
        //   沉浸式 v1.28.5 content_main_beauty.js:45687 `I$()` 检 mutation 整段
        //   self-induced 时整条 skip (默认 checkSelfUpdate=true).
        // 老 F6 200ms reinject 是反应式补丁, 实测在 X 上跟 React reconcile 形成死循环
        // (V 12s 89 次 add/rm 实测铁证). 删之. React 删 .bbt-tr 后 babata 不反应,
        // 下次 mutation cycle 通过 addedNodes 路径自然 reprocess.
      }
    });
  }
  if (observedMutationRoots.has(root)) return;
  mo.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
  });
  observedMutationRoots.add(root);
}

// ── boot ──────────────────────────────────────────────────────────────

function resolveMode(
  base = baseMode,
  hosts = alwaysTranslateHosts,
  disabledHosts = alwaysTranslateDisabledHosts,
): Mode {
  return effectiveTranslationModeForHost(base, hosts, currentHost, disabledHosts);
}

async function loadMode() {
  try {
    const got = await chrome.storage.local.get([
      STORAGE_MODE,
      STORAGE_SELECTION_TRANSLATION,
      STORAGE_ALWAYS_TRANSLATE_HOSTS,
      STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
    ]);
    const stored = got[STORAGE_MODE];
    baseMode = normalizeMode(stored);
    alwaysTranslateHosts = normalizeHostList(got[STORAGE_ALWAYS_TRANSLATE_HOSTS]);
    alwaysTranslateDisabledHosts = normalizeHostList(got[STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS]);
    mode = resolveMode();
    selectionTranslationEnabled = got[STORAGE_SELECTION_TRANSLATION] === true;
    // 老 "auto/off" 一次性迁移到渲染模式: 是否翻译由 host checkbox 决定.
    if (stored === "auto" || stored === "off" || stored === undefined) {
      void chrome.storage.local.set({ [STORAGE_MODE]: baseMode });
    }
  } catch {
    /* default replace */
  }
}

// CSS rules — mode 切换不重调 LLM, 只重绘 page-side cached translation nodes.
// 关键设计:
//   replace 用 `:has(+ .${TR_CLASS})` 避免空窗 — leaf 只在 sibling 译文已 inject 时
//   才隐藏, 翻译没回来前 leaf 仍显示原文 (V 反馈 "少了一大堆" = 之前无条件 hide).
//   replace 的 .bbt-tr-native 复制原 leaf tag/class/style/data state, 让站点原 CSS 决定
//   字号/间距/布局; bilingual 才用额外 display + border-left / 字号 / margin 装饰区分.
const MODE_STYLE_ID = "bbt-mode-style";
function modeStyleText(root: Document | ShadowRoot): string {
  const modeSelector = root instanceof ShadowRoot
    ? (v: Mode) => `:host([data-bbt-mode="${v}"])`
    : (v: Mode) => `html[data-bbt-mode="${v}"]`;
  return `
    .${TR_CLASS} { color: inherit; }
    ${modeSelector("off")} .${TR_CLASS} { display: none !important; }
    ${modeSelector("replace")} [${LEAF_ATTR}]:has(+ .${TR_CLASS}) { display: none !important; }
    ${modeSelector("replace")} .${TR_NATIVE_CLASS} { color: inherit; }
    ${modeSelector("replace")} [${INPLACE_ATTR}]:has(.${TR_INPLACE_CLASS}) .${SRC_CLASS} {
      display: none !important;
    }
    ${modeSelector("replace")} [${INPLACE_ATTR}] .${TR_INPLACE_CLASS} {
      color: inherit;
    }
    ${modeSelector("bilingual")} .${TR_INLINE_CLASS} { display: inline; }
    ${modeSelector("bilingual")} .${TR_BLOCK_CLASS} { display: block; }
    ${modeSelector("bilingual")} .${TR_BLOCK_CLASS} {
      color: #5b5b5b;
      font-size: .95em;
      line-height: 1.5;
      margin-top: 3px;
      border-left: 2px solid #d8d2c5;
      padding-left: 8px;
    }
    ${modeSelector("bilingual")} .${TR_INLINE_CLASS} {
      color: #5b5b5b;
      margin-left: 4px;
    }
  `;
}

function injectModeStyle(root: Document | ShadowRoot = document) {
  let style = root.getElementById(MODE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = MODE_STYLE_ID;
    if (root instanceof ShadowRoot) {
      root.appendChild(style);
    } else {
      (document.head || document.documentElement).appendChild(style);
    }
  }
  style.textContent = modeStyleText(root);
}

function removeModeStyles() {
  for (const root of translationRoots()) {
    root.getElementById(MODE_STYLE_ID)?.remove();
  }
}
function applyModeAttr() {
  document.documentElement.setAttribute("data-bbt-mode", mode);
  for (const root of activeShadowRoots()) {
    applyShadowRootModeAttr(root);
  }
}

function boot() {
  broadcastTeardown();
  const w = window as unknown as { __babataTranslateBooted?: boolean };
  if (w.__babataTranslateBooted) return;
  w.__babataTranslateBooted = true;
  document.addEventListener(TEARDOWN_EVENT, teardownAll);
  registerCleanup(() => document.removeEventListener(TEARDOWN_EVENT, teardownAll));

  injectModeStyle();
  void loadMode().then(() => {
    applyModeAttr();
    makeIO();
    observeNew(document.body);
    observeMutations();
    setupAttentionWatchers();
    setupSelectionTranslator();
    startCleanupTimer();
    startStableWindowTimer();
  });

  try {
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      let modeChanged = false;
      if (changes[STORAGE_MODE]) {
        baseMode = normalizeMode(changes[STORAGE_MODE].newValue);
        modeChanged = true;
      }
      if (changes[STORAGE_ALWAYS_TRANSLATE_HOSTS]) {
        alwaysTranslateHosts = normalizeHostList(changes[STORAGE_ALWAYS_TRANSLATE_HOSTS].newValue);
        modeChanged = true;
      }
      if (changes[STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS]) {
        alwaysTranslateDisabledHosts = normalizeHostList(
          changes[STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS].newValue,
        );
        modeChanged = true;
      }
      if (modeChanged) {
        const prev = mode;
        mode = resolveMode();
        applyModeAttr();
        // bilingual ↔ replace 需要重绘 wrapper 形态: replace 用 native clone,
        // bilingual 用中性 font sibling; 译文本身仍走 L1 cache, 不重调 LLM.
        if (prev !== mode && mode !== "off") {
          rerenderCachedTranslations();
          // off → bilingual/replace: 之前没翻新内容, 触发 collect 走 cache hit / enqueue.
          observeNew(document.body, "rerun");
        }
      }
      if (changes[STORAGE_SELECTION_TRANSLATION]) {
        selectionTranslationEnabled = changes[STORAGE_SELECTION_TRANSLATION].newValue === true;
        document.dispatchEvent(new Event(SELECTION_SETTING_EVENT));
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    registerCleanup(() => chrome.storage.onChanged.removeListener(onStorageChanged));
  } catch {
    /* extension context invalidated — 老 content script 不 re-bind, V 刷 page 后新 SC 接手 */
  }

  // F8: page unload / extension reload 时清 timer + MO, 防老 content script leak.
  window.addEventListener("pagehide", teardownAll, { once: true });
  registerCleanup(() => window.removeEventListener("pagehide", teardownAll));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

export {};
