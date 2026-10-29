/// <reference types="chrome" />

import { requestTranslation } from "./translation-client";
import { shouldTranslateText } from "../translation-language";
import { encodeTranslationSource, renderTranslationMarkup, splitTranslationText } from "./translation-markup";
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
//   L1 cache — a byte-bounded document LRU; remounts restore before paint.
//   The shared transport owns provider-level deduplication and cancellation.
//
// Fixes the common SPA timeline failure mode: scroll down misses text, scroll
// back up loses previously injected translations.
//
// 安全: 译文来自 LLM (untrusted), 走 DOMPurify 白名单 (inline format only).

const HASH_ATTR = "data-bbt-hash";
const LEAF_ATTR = "data-bbt-leaf";
const TR_CLASS = "bbt-tr";
const TEARDOWN_EVENT = "babata:translate-teardown";
// inline-leaf (X span/a/strong) 跟 block-leaf (P/DIV/blockquote) 的 sibling 译文
// 视觉应跟 leaf 一致 — block-leaf 后 block 占行, inline-leaf 后 inline 流畅. 用 marker
// class 区分, 让 CSS rule (mode-aware) 控制装饰. inline TR_STYLE 的 border-left+block
// Heavy decoration in replace mode becomes visual noise on dense feeds.
const TR_INLINE_CLASS = "bbt-tr-inline";
const TR_BLOCK_CLASS = "bbt-tr-block";
const TR_NATIVE_CLASS = "bbt-tr-native";
const TR_INPLACE_CLASS = "bbt-tr-inplace";
const SRC_CLASS = "bbt-src";
const INPLACE_ATTR = "data-bbt-inplace";
const SELECTION_SETTING_EVENT = "babata:selection-translation-setting";
// Translate once, inject sibling .bbt-tr forever. Replace/bilingual/off modes
// are CSS-only after the first model call. Direct innerHTML replacement fights
// React-style reconciliation, so the original DOM is left intact.
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
interface TranslationPart {
  hash: string;
  text: string;
  translated?: string;
  attempts: number;
  inFlight: boolean;
  retryAt: number;
}
interface QueueItem {
  el: HTMLElement;
  elements: Set<HTMLElement>;
  text: string;
  requestText: string;
  visible: boolean;
  parts: TranslationPart[];
}
const queue = new Map<string, QueueItem>();
let flushTimer: number | null = null;
const activeRequests = new Set<AbortController>();
const rejectedHashes = new Set<string>();
const MAX_PARALLEL_BATCHES = 2;
let active = false;
let lifecycle = 0;
const CACHE_MAX = 5000;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
let cacheBytes = 0;
let injectedTranslations = new WeakMap<HTMLElement, HTMLElement>();
let translationOwners = new WeakMap<HTMLElement, HTMLElement>();
let sourceSnapshots = new WeakMap<HTMLElement, string>();
let repairWindows = new WeakMap<HTMLElement, { at: number; count: number; hash: string }>();
let refreshingElements = new WeakSet<HTMLElement>();

function cachedTranslation(hash: string): string | undefined {
  const value = cache.get(hash);
  if (value !== undefined) { cache.delete(hash); cache.set(hash, value); }
  return value;
}
function cacheTranslation(hash: string, translated: string) {
  cacheBytes -= (cache.get(hash)?.length || 0) * 2;
  cache.delete(hash);
  if (translated.length * 2 > CACHE_MAX_BYTES) return;
  cache.set(hash, translated);
  cacheBytes += translated.length * 2;
  while (cache.size > CACHE_MAX || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value!;
    cacheBytes -= (cache.get(oldest)?.length || 0) * 2;
    cache.delete(oldest);
  }
}

const TARGET_LANG = "zh";
// Batch enough visible text together so nearby page content translates in a
// coherent order instead of one small leaf at a time.
const BATCH_SIZE = 12;
const FIRST_BATCH_SIZE = 4;
let completedBatches = 0;
const TRANSLATION_BATCH_CHAR_BUDGET = 6000;
const FLUSH_DEBOUNCE_MS = 24;
// Brief tab switches and scroll reversals should keep the same subscription.
// The companion independently bounds any remaining orphaned provider work.
const DEPARTURE_CANCEL_DELAY_MS = 180;
// Keep provider work bounded. Farther paragraphs stay observed, and queue
// saturation triggers an incremental refill instead of evicting visible text.
const QUEUE_MAX = 5000;
let needsQueueRefill = false;
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

// After extension reload, old content scripts remain on the page and
// chrome.runtime APIs can throw synchronously. `.catch()` cannot catch that, so
// one invalidation flips a local guard until the page reloads.
let extInvalidated = false;
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
    if (document.visibilityState === "hidden") cancelScanTasks();
    else { observeNew(document.body, "rerun"); scheduleFlush(0); }
    updateBatchCancellation();
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

// ── universal leaf-text walk ───────────────────────────────────────────

// Inline tags that should stay in the same translated visual line.
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

// Core translation gates: thresholds, preserved tags, math selectors, atomic
// blocks, and line-break abbreviations.
const PARAGRAPH_MIN_TEXT_COUNT = 4;
const BLOCK_MIN_TEXT_COUNT = 24;
const MAIN_FRAME_MIN_TEXT_COUNT = 50;
// Long-form leaves are split into balanced marker chunks at the transport
// boundary, so document length never becomes a language/coverage filter.
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
  '[translate="no"]', ".notranslate",
  '[data-bbt-clean-read-active="1"]',
  '[contenteditable]:not([contenteditable="false"])', '[aria-hidden="true"]',
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
// Physical leaf mark written to the DOM. A permanent WeakSet lock is brittle:
// if new text appears inside an already-claimed subtree, collection can miss it;
// if injected translations are removed externally, reinjection is blocked.
let multiCache = new WeakMap<HTMLElement, boolean>();
// inline 判断缓存 — getComputedStyle 同步 reflow, 同元素重复调贵.
let inlineCache = new WeakMap<HTMLElement, boolean>();
let hiddenCache = new WeakMap<HTMLElement, boolean>();
// MO sentinel — 自己 inject 的 .bbt-tr font 加进, MO addedNodes 跳 (kiss translator.js:319,711).
const skipMoNodes = new WeakSet<Node>();
// Trailing stable-window scanner. A leading throttle can capture unstable text
// from the first mutation and then suppress the later settled content. Here
// every mutation refreshes the timestamp, and processing only happens after a
// quiet window.
const STABLE_WINDOW_MS = 120;
const STABLE_MAX_WAIT_MS = 500;
const stableWindowMap = new Map<HTMLElement, { ts: number; firstAt: number; src: TraceSource }>();
let stableWindowTimer: number | null = null;
// element in-flight 锁 — 同 element 已 enqueue 在 LLM 中, 新 mutation 不重 enqueue.
let inFlightElements = new WeakSet<HTMLElement>();
// hash in-flight 锁 — 跨 element instance 同 text. X swap SPAN 时新 instance 不在
// inFlightElements (WeakSet 是 element 级), 重新走 doProcessCandidate, cache 还没 set
// (flush async 在 server roundtrip 中), 又 enqueue 触发并发 flush. 两次 server 调用同
// text can receive different model outputs and overwrite the cache.
// hash 锁让同 text 跨 instance 串行: 第一次 enqueue 锁, flush 完返结果再解锁.
const inFlightHashes = new Set<string>();

// ── client trace instrumentation ───────────────────────────────────────
// 每次 processCandidate 在每个 decision 点记一条 trace. batch flush 经 SW POST
// /translate_trace lets the companion record decision points for debugging
// flicker and missing-translation reports with data instead of guesses.
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
  if (observedShadowRoots.has(root)) return;
  observedShadowRoots.add(root);
  applyShadowRootModeAttr(root);
  injectModeStyle(root);
  observeMutations(root);
}

let mo: MutationObserver | null = null;
let observedMutationRoots = new WeakSet<ParentNode>();
let observedShadowRoots = new Set<ShadowRoot>();
const cleanupFns: Array<() => void> = [];

function registerCleanup(fn: () => void) {
  cleanupFns.push(fn);
}

// A short content-only debounce has a maximum wait; CSS churn cannot starve it.
function startStableWindowTimer() {
  if (stableWindowTimer !== null) return;
  stableWindowTimer = window.setInterval(() => {
    if (stableWindowMap.size === 0) return;
    const now = Date.now();
    const ready: { el: HTMLElement; src: TraceSource }[] = [];
    for (const [el, info] of stableWindowMap) {
      if (now - info.ts >= STABLE_WINDOW_MS || now - info.firstAt >= STABLE_MAX_WAIT_MS) {
        ready.push({ el, src: info.src });
        stableWindowMap.delete(el);
      }
    }
    for (const { el, src } of ready) {
      if (el.isConnected) doProcessCandidate(el, src);
    }
  }, 50);
}
function teardownAll() {
  // A detached extension context can reject an older message after a new
  // engine has taken over the same document. Cleanup belongs to its first
  // teardown only; a late rejection must not erase the replacement's DOM.
  if (!active) return;
  active = false;
  lifecycle += 1;
  const w = window as unknown as { __babataTranslateBooted?: boolean };
  w.__babataTranslateBooted = false;
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
  cancelPageRequests();
  cancelScanTasks();
  inFlightElements = new WeakSet<HTMLElement>();
  stableWindowMap.clear();
  inFlightHashes.clear();
  visibleHashes.clear();
  rejectedHashes.clear();
  sourceSnapshots = new WeakMap();
  repairWindows = new WeakMap();
  refreshingElements = new WeakSet();
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

// Skip visually hidden subtrees.
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
    || el.matches(STAY_ORIGINAL_SELECTOR)
    || el.matches('[translate="no"], .notranslate');
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
  // A targeted native query finds media beyond the bounded CSS inspection.
  // Structural ancestors are rejected before reaching this leaf-only check.
  let mediaCount = 0;
  for (const media of el.querySelectorAll<HTMLElement>(RICH_MEDIA_SELECTOR)) {
    if (++mediaCount > RICH_MEDIA_SCAN_LIMIT) return true;
    if (isTranslationElement(media) || isHidden(media)) continue;
    if (hasNaturalMediaBox(media) || hasLargeVisualBox(media)
      || (isBlockRenderedMedia(media) && hasMediaSource(media))) return true;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return node instanceof HTMLElement && !isTranslationElement(node)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node: Node | null = el;
  let scanned = 0;
  while (node && scanned++ < RICH_MEDIA_SCAN_LIMIT) {
    if (node instanceof HTMLElement && !isHidden(node)) {
      const media = node.matches(RICH_MEDIA_SELECTOR);
      if (media && (hasNaturalMediaBox(node) || hasLargeVisualBox(node)
        || (node !== el && isBlockRenderedMedia(node) && hasMediaSource(node)))) return true;
      if (hasLargeVisualBox(node) && hasCssBackgroundImage(node)) return true;
    }
    node = walker.nextNode();
  }
  // TreeWalker bounds allocation and CSS background inspection; plain text
  // paragraphs may contain any number of inline formatting nodes.
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

function normalizeSourceText(text: string): string {
  return text
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, (_match, offset, full: string) => {
      const before = full.slice(Math.max(0, offset - 24), offset).trim();
      return LINE_BREAK_ABBREVIATION_RE.test(before) ? " " : "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Read only the page's source text, never our injected sibling/wrapper text.
// This is the idempotency boundary for language detection and trace text.
function buildSourceText(el: HTMLElement): string {
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
  return normalizeSourceText(parts.join(""));
}

function sourceText(el: HTMLElement): string {
  return buildSourceText(el);
}

function sourcePlan(el: HTMLElement) {
  return encodeTranslationSource(el, {
    skip: (node) => isTranslationElement(node) || isIgnoredElement(node)
      || (!node.classList.contains(SRC_CLASS) && isHidden(node)),
    preserve: (node) => isStayOriginalElement(node) && !isTranslationElement(node),
    block: (node) => FORCE_BLOCK_TAGS.has(node.tagName),
  });
}

function sourceTextForTranslation(el: HTMLElement): string {
  return sourcePlan(el).text;
}

function isLeafTextElement(el: HTMLElement, knownHasRichMedia?: boolean): boolean {
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
  if (knownHasRichMedia === undefined && hasRichMediaSurface(el)) return false;
  const text = sourceText(el);
  return shouldTranslate(text, DEFAULT_MIN_TEXT_COUNT, el);
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

function* walkTranslatable(root: ParentNode): Generator<HTMLElement | null> {
  const stack: Element[] = root instanceof HTMLElement ? [root]
    : root instanceof Document ? [document.body] : Array.from(root.children).reverse();
  while (stack.length) {
    const el = stack.pop();
    // Yield even when a node is rejected, so a huge excluded/structural tree
    // cannot monopolize a frame between two accepted leaves.
    yield null;
    if (!(el instanceof HTMLElement) || isIgnoredElement(el) || hasLeafAncestor(el) || isHidden(el)) continue;
    if (el.shadowRoot) registerShadowRoot(el.shadowRoot);
    const inline = isInlineElement(el);
    const atomic = isAtomicBlockElement(el);
    const descend = () => {
      if (el.shadowRoot) stack.push(...Array.from(el.shadowRoot.children).reverse());
      stack.push(...Array.from(el.children).reverse());
    };
    // Reject structural containers before any descendant scan or layout read.
    if (!inline && !atomic && hasNonInlineElementChild(el)) { descend(); continue; }
    const containsTranslation = hasTranslationChild(el);
    const rich = hasRichMediaSurface(el);
    if (!containsTranslation && !rich && atomic && shouldTranslate(sourceText(el), BLOCK_MIN_TEXT_COUNT, el)) {
      el.setAttribute(LEAF_ATTR, "1"); yield el; continue;
    }
    if (!containsTranslation && !rich && !inline && !hasTextBlockSemantics(el) && isMultiSegmentInline(el)) {
      descend(); continue;
    }
    if (!containsTranslation && isLeafTextElement(el, rich)) {
      el.setAttribute(LEAF_ATTR, "1"); yield el; continue;
    }
    descend();
  }
}

function shouldTranslate(text: string, minTextCount = DEFAULT_MIN_TEXT_COUNT, el?: HTMLElement): boolean {
  if (!text || text.length < minTextCount) return false;
  if (/^e\.g[.,]?\s+/i.test(text.trim())) return false;
  if (/^[@#][\p{L}\p{N}_-]+$/u.test(text.trim())) return false;
  if (/^[a-z0-9][a-z0-9._/-]{1,39}$/u.test(text.trim())) return false;
  const hint = el?.closest("[lang]")?.getAttribute("lang") || document.documentElement.lang;
  return shouldTranslateText(text, TARGET_LANG, hint);
}

// ── hash (FNV-1a-ish 64bit, 16 hex chars) ─────────────────────────────

// When feeds repeatedly swap SPAN nodes, subtle whitespace differences can
// create different hashes for visually identical text. Normalize:
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

async function translateSelectionText(text: string, signal: AbortSignal): Promise<string | null> {
  if (!selectionTranslationEnabled) return null;
  const generation = lifecycle;
  const hash = hashText(normalizeForHash(text), TARGET_LANG);
  const cached = cachedTranslation(hash);
  if (cached) return cached;
  try {
    const response = await requestTranslation({ site: location.hostname, url: location.href, target: TARGET_LANG,
      priority: "interactive", batch: [{ hash, text }] }, { signal });
    if (!active || generation !== lifecycle || signal.aborted) return null;
    const translated = response.results?.find((item) => item.hash === hash)?.translated?.trim();
    if (!translated) return null;
    cacheTranslation(hash, translated);
    return translated;
  } catch { return null; }
}

function setupSelectionTranslator() {
  const popup = createSelectionPopup();
  let timer: number | null = null;
  let requestSeq = 0;
  let selectionRequest: AbortController | null = null;

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
      hideAndInvalidate();
      return;
    }

    const seq = ++requestSeq;
    positionSelectionPopup(popup.host, snapshot.rect);
    renderSelectionPopup(popup, "loading", "…");
    selectionRequest?.abort();
    selectionRequest = new AbortController();
    const translated = await translateSelectionText(snapshot.text, selectionRequest.signal);
    if (seq !== requestSeq) return;
    if (!translated) {
      renderSelectionPopup(popup, "error", "没有拿到译文，稍后再试。");
      return;
    }
    renderSelectionPopup(popup, "ready", translated);
  }

  function hideAndInvalidate() {
    selectionRequest?.abort();
    selectionRequest = null;
    requestSeq++;
    clearTimer();
    hideSelectionPopup(popup);
  }

  const onSelectionChange = () => { hideAndInvalidate(); schedule(); };
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

  const onSelectionVisibility = () => { if (document.visibilityState === "hidden") hideAndInvalidate(); };
  document.addEventListener("babata:translation-config-changed", hideAndInvalidate);
  document.addEventListener("visibilitychange", onSelectionVisibility);
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
    document.removeEventListener("babata:translation-config-changed", hideAndInvalidate);
    document.removeEventListener("visibilitychange", onSelectionVisibility);
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
  const owned = injectedTranslations.get(el);
  if (owned) { translationOwners.delete(owned); io?.unobserve(owned); }
  owned?.remove();
  injectedTranslations.delete(el);
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
  translationOwners = new WeakMap();
  for (const root of translationRoots()) {
    root.querySelectorAll(`.${TR_CLASS}`).forEach((node) => node.remove());
  }
  injectedTranslations = new WeakMap<HTMLElement, HTMLElement>();
}

function isElementNearViewport(el: HTMLElement): boolean {
  const translated = injectedTranslations.get(el);
  const rect = translated?.isConnected ? translated.getBoundingClientRect() : el.getBoundingClientRect();
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
  if (el instanceof HTMLAnchorElement && node instanceof HTMLAnchorElement) {
    copyAnchorPresentation(el, node);
  }
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

function copyAnchorPresentation(src: HTMLAnchorElement, dst: HTMLAnchorElement) {
  try {
    const cs = window.getComputedStyle(src);
    if (cs.color && cs.color !== "rgba(0, 0, 0, 0)" && cs.color !== "transparent") {
      dst.style.color = cs.color;
    }
    if (cs.textDecorationLine) {
      dst.style.textDecorationLine = cs.textDecorationLine;
    }
    if (cs.textDecorationStyle) {
      dst.style.textDecorationStyle = cs.textDecorationStyle;
    }
    if (cs.textDecorationColor) {
      dst.style.textDecorationColor = cs.textDecorationColor;
    }
    dst.style.cursor = "pointer";
  } catch {
    dst.style.cursor = "pointer";
  }
}


function injectTranslation(el: HTMLElement, raw: string) {
  if (!active || !el.isConnected) return;
  refreshingElements.delete(el);
  clearTranslation(el);
  if (mode === "off" || !raw || isIgnoredElement(el)) return;
  const original = sourceText(el);
  if (raw.trim() === original) return;
  const safe = renderTranslationMarkup(raw, sourcePlan(el));
  const inlineLeaf = isInlineElement(el);
  if (shouldRenderInPlace(el, original)) {
    const template = markInPlaceSource(el);
    const tr = createInPlaceTranslationElement(template, safe);
    injectedTranslations.set(el, tr);
    translationOwners.set(tr, el);
    io?.observe(tr);
    skipMoNodes.add(tr);
    el.setAttribute(INPLACE_ATTR, "1");
    if (template) {
      template.insertAdjacentElement("afterend", tr);
    } else {
      el.appendChild(tr);
    }
    return;
  }
  const tr = createTranslationElement(el, safe, inlineLeaf);
  injectedTranslations.set(el, tr);
  translationOwners.set(tr, el);
  io?.observe(tr);
  // MO sentinel: 自己 inject 的 node 加进 skipMoNodes, MO addedNodes 看到跳 (防自触发).
  skipMoNodes.add(tr);
  // Sibling injection avoids mutating the source leaf. Infinite-loop prevention
  // comes from ignoring removedNodes, not from appending inside the source leaf.
  el.insertAdjacentElement("afterend", tr);
}

function rerenderCachedTranslations() {
  clearAllTranslations();
  if (mode === "off") return;
  for (const root of translationRoots()) {
    root.querySelectorAll(`[${HASH_ATTR}]`).forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const text = sourceText(node);
      if (!shouldTranslate(text)) return;
      const requestText = sourceTextForTranslation(node);
      const fresh = hashText(normalizeForHash(requestText), TARGET_LANG);
      const translated = cachedTranslation(fresh);
      if (translated !== undefined) {
        node.setAttribute(HASH_ATTR, fresh);
        injectTranslation(node, translated);
        return;
      }
      processCandidate(node, "rerun");
    });
  }
}

// ── candidate processing ──────────────────────────────────────────────

function processCandidate(el: HTMLElement, src: TraceSource = "init") {
  if (!active || mode === "off" || document.visibilityState === "hidden" || !el.isConnected) return;
  el = candidateRoot(el);
  const text = sourceTextForTranslation(el);
  const previous = sourceSnapshots.get(el);
  sourceSnapshots.set(el, text);
  const hash = hashText(normalizeForHash(text), TARGET_LANG);
  const repair = repairWindows.get(el);
  if (repair && repair.count > 3 && repair.hash === hash) return;
  if (repair && repair.hash !== hash) repairWindows.delete(el);
  // Cached virtual-list mounts and removed generated siblings recover in the
  // current mutation microtask, before the browser paints the source again.
  if (cache.has(hash)) {
    stableWindowMap.delete(el);
    if (!hasInjectedTranslation(el) || el.getAttribute(HASH_ATTR) !== hash) doProcessCandidate(el, src);
    return;
  }
  if (previous === text) {
    if (!stableWindowMap.has(el) && !inFlightElements.has(el) && isElementNearViewport(el)) doProcessCandidate(el, src);
    return;
  }
  if (src === "rerun" || src === "init") { doProcessCandidate(el, src); return; }
  const previousWindow = stableWindowMap.get(el);
  stableWindowMap.set(el, { ts: Date.now(), firstAt: previousWindow?.firstAt ?? Date.now(), src });
}

function releaseQueueItem(hash: string, item: QueueItem) {
  if (queue.get(hash) === item) queue.delete(hash);
  inFlightHashes.delete(hash);
  item.elements.forEach((element) => inFlightElements.delete(element));
}

function finishQueueItem(hash: string, item: QueueItem): boolean {
  if (queue.get(hash) !== item || !item.parts.every((part) => part.translated !== undefined)) return false;
  const translated = item.parts.map((part) => part.translated).join("");
  cacheTranslation(hash, translated);
  releaseQueueItem(hash, item);
  for (const element of item.elements) {
    if (!element.isConnected) continue;
    const current = sourceTextForTranslation(element);
    if (hashText(normalizeForHash(current), TARGET_LANG) === hash) {
      if (hasVisibleSurface(element)) injectTranslation(element, translated);
    } else processCandidate(element, "mo_char");
  }
  return true;
}

function doProcessCandidate(el: HTMLElement, src: TraceSource) {
  if (!active || mode === "off" || document.visibilityState === "hidden" || !el.isConnected) return;
  if (isIgnoredElement(el)) { clearCandidateState(el); return; }
  const hasInjected = hasInjectedTranslation(el);
  if (!hasInjected && isHidden(el)) return;
  const text = sourceText(el);
  if (!shouldTranslate(text, DEFAULT_MIN_TEXT_COUNT, el)) { clearCandidateState(el); return; }
  if (hasRichMediaSurface(el)) { clearCandidateState(el); observeNew(el, src); return; }
  const requestText = sourceTextForTranslation(el);
  const fresh = hashText(normalizeForHash(requestText), TARGET_LANG);
  sourceSnapshots.set(el, requestText);
  const existing = el.getAttribute(HASH_ATTR);
  if (hasInjected && existing === fresh && !refreshingElements.has(el)) return;
  if (existing && existing !== fresh) {
    const old = queue.get(existing);
    old?.elements.delete(el);
    if (old && old.elements.size === 0) releaseQueueItem(existing, old);
    clearTranslation(el);
  }
  el.setAttribute(HASH_ATTR, fresh);
  el.setAttribute(LEAF_ATTR, "1");
  const cached = cachedTranslation(fresh);
  if (cached !== undefined) { injectTranslation(el, cached); return; }
  if (rejectedHashes.has(fresh)) return;
  // Only the current viewport and a bounded 800px look-ahead can consume
  // provider work. IntersectionObserver retains every farther candidate.
  if (!isElementNearViewport(el)) return;
  const queued = queue.get(fresh);
  if (queued) { queued.elements.add(el); inFlightElements.add(el); return; }
  if (queue.size >= QUEUE_MAX) {
    for (const [hash, item] of queue) {
      if (!item.parts.some((part) => part.inFlight) && !isElementNearViewport(item.el)) releaseQueueItem(hash, item);
    }
    // Keep the oldest visible paragraph and refill after capacity is released.
    if (queue.size >= QUEUE_MAX) { needsQueueRefill = true; return; }
  }
  inFlightElements.add(el);
  inFlightHashes.add(fresh);
  const parts = splitTranslationText(requestText).map((part) => {
    const hash = hashText(normalizeForHash(part), TARGET_LANG);
    return { hash, text: part, translated: cachedTranslation(hash), attempts: 0, inFlight: false, retryAt: 0 };
  });
  if (parts.length && parts.every((part) => part.translated !== undefined)) {
    const translated = parts.map((part) => part.translated).join("");
    cacheTranslation(fresh, translated);
    inFlightElements.delete(el);
    inFlightHashes.delete(fresh);
    injectTranslation(el, translated);
    return;
  }
  const item = { el, elements: new Set([el]), text, requestText, visible: isActuallyVisible(el), parts };
  queue.set(fresh, item);
  attachPendingChunkOwners([item]);
  updateBatchCancellation();
  trace(src, el, fresh, "enqueue", text);
  scheduleFlush();
}

function isActuallyVisible(el: HTMLElement): boolean {
  const translated = injectedTranslations.get(el);
  const rect = translated?.isConnected ? translated.getBoundingClientRect() : el.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= innerHeight && rect.right >= 0 && rect.left <= innerWidth;
}

const batchOwners = new Map<AbortController, QueueItem[]>();
const batchCancellationTimers = new Map<AbortController, number>();
const chunkFlights = new Map<string, { text: string; controller: AbortController }>();

function attachPendingChunkOwners(items: Iterable<QueueItem> = queue.values()) {
  for (const item of items) {
    for (const part of item.parts) {
      const flight = chunkFlights.get(part.hash);
      if (!flight || flight.text !== part.text || part.translated !== undefined) continue;
      part.inFlight = true;
      const owners = batchOwners.get(flight.controller);
      if (owners && !owners.includes(item)) owners.push(item);
    }
  }
}

function hasVisibleSurface(el: HTMLElement): boolean {
  if (!el.isConnected || isIgnoredElement(el)) return false;
  // Replace mode intentionally hides the source while its generated sibling
  // remains visible. Use that sibling when refreshing an existing translation.
  const translated = injectedTranslations.get(el);
  for (let node: HTMLElement | null = translated?.isConnected ? translated : el; node; node = node.parentElement) {
    if (isHidden(node)) return false;
  }
  return true;
}

function batchStillNeeded(owners: QueueItem[]): boolean {
  return document.visibilityState !== "hidden" && owners.some((item) =>
    [...item.elements].some((element) => hasVisibleSurface(element) && isElementNearViewport(element)));
}

function clearBatchCancellation(controller: AbortController) {
  const timer = batchCancellationTimers.get(controller);
  if (timer !== undefined) clearTimeout(timer);
  batchCancellationTimers.delete(controller);
}

function updateBatchCancellation() {
  for (const [controller, owners] of batchOwners) {
    if (batchStillNeeded(owners)) { clearBatchCancellation(controller); continue; }
    if (controller.signal.aborted || batchCancellationTimers.has(controller)) continue;
    batchCancellationTimers.set(controller, window.setTimeout(() => {
      batchCancellationTimers.delete(controller);
      const current = batchOwners.get(controller);
      if (current && !batchStillNeeded(current)) controller.abort();
    }, DEPARTURE_CANCEL_DELAY_MS));
  }
}

function cancelPageRequests() {
  for (const controller of batchCancellationTimers.keys()) clearBatchCancellation(controller);
  for (const controller of activeRequests) controller.abort();
  activeRequests.clear();
  batchOwners.clear();
  chunkFlights.clear();
  queue.clear();
  inFlightHashes.clear();
  inFlightElements = new WeakSet();
  stableWindowMap.clear();
  completedBatches = 0;
  needsQueueRefill = false;
}

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS) {
  if (!active || mode === "off" || document.visibilityState === "hidden" || activeRequests.size >= MAX_PARALLEL_BATCHES || flushTimer !== null) return;
  flushTimer = window.setTimeout(flush, delayMs);
}

interface SelectedPart { ownerHash: string; item: QueueItem; part: TranslationPart }
function flush() {
  flushTimer = null;
  if (!active || mode === "off" || document.visibilityState === "hidden") return;
  while (activeRequests.size < MAX_PARALLEL_BATCHES) {
    attachPendingChunkOwners();
    const candidates: Array<[string, QueueItem]> = [];
    for (const [hash, item] of queue) {
      for (const element of item.elements) {
        if (!element.isConnected || isIgnoredElement(element)) { item.elements.delete(element); inFlightElements.delete(element); }
      }
      for (const part of item.parts) {
        if (part.translated === undefined && !part.inFlight) part.translated = cachedTranslation(part.hash);
      }
      if (finishQueueItem(hash, item)) continue;
      const live = [...item.elements].find((element) => hasVisibleSurface(element) && isElementNearViewport(element));
      if (live) { item.el = live; item.visible = isActuallyVisible(live); candidates.push([hash, item]); }
      else if (!item.parts.some((part) => part.inFlight)) releaseQueueItem(hash, item);
    }
    candidates.sort((a, b) => Number(b[1].visible) - Number(a[1].visible));
    const selected: SelectedPart[] = [];
    const selectedHashes = new Set<string>();
    const size = completedBatches === 0 ? FIRST_BATCH_SIZE : BATCH_SIZE;
    let chars = 0;
    let retryAt = Infinity;
    const now = Date.now();
    for (const [ownerHash, item] of candidates) {
      for (const part of item.parts) {
        if (part.translated !== undefined || part.inFlight || chunkFlights.has(part.hash) || selectedHashes.has(part.hash)) continue;
        if (part.retryAt > now) { retryAt = Math.min(retryAt, part.retryAt); continue; }
        if (selected.length >= size || (selected.length && chars + part.text.length > TRANSLATION_BATCH_CHAR_BUDGET)) break;
        part.inFlight = true;
        selectedHashes.add(part.hash);
        selected.push({ ownerHash, item, part });
        chars += part.text.length;
      }
      if (selected.length >= size) break;
    }
    if (!selected.length) {
      if (Number.isFinite(retryAt)) scheduleFlush(Math.max(1, retryAt - now));
      break;
    }
    const controller = new AbortController();
    activeRequests.add(controller);
    batchOwners.set(controller, Array.from(new Set(selected.map(({ item }) => item))));
    for (const { part } of selected) chunkFlights.set(part.hash, { text: part.text, controller });
    attachPendingChunkOwners();
    void runBatch(selected, controller, lifecycle);
  }
}

async function runBatch(selected: SelectedPart[], controller: AbortController, generation: number) {
  try {
    const response = await requestTranslation({
      site: location.hostname, url: location.href, target: TARGET_LANG,
      priority: selected.some(({ item }) => item.visible) ? "visible" : "prefetch",
      // A chunk has one in-flight wire item across all paragraph owners.
      batch: selected.map(({ part }) => ({ hash: part.hash, text: part.text })),
    }, { signal: controller.signal });
    if (!active || generation !== lifecycle || controller.signal.aborted) return;
    completedBatches++;
    const results = new Map((response.results || []).filter((item) => typeof item?.translated === "string" && item.translated.trim()).map((item) => [item.hash, item.translated]));
    const errors = new Map((response.errors || []).map((error) => [error.hash, error]));
    const sources = new Map(selected.map(({ part }) => [part.hash, part.text]));
    for (const { part } of selected) {
      const translated = results.get(part.hash);
      if (translated !== undefined) cacheTranslation(part.hash, translated);
    }
    // Owners can join after dispatch. Apply the outcome to every matching
    // position while retaining each paragraph's original assembly order.
    for (const [ownerHash, item] of queue) {
      for (const part of item.parts) {
        if (part.translated !== undefined || sources.get(part.hash) !== part.text) continue;
        const translated = results.get(part.hash);
        if (translated !== undefined) {
          part.translated = translated;
          continue;
        }
        const error = errors.get(part.hash);
        part.attempts++;
        const retryable = error?.retryable ?? response.retryable ?? true;
        const limit = response.ok ? MISSING_RESULT_MAX_RETRIES : TRANSPORT_MAX_RETRIES;
        if (!retryable || part.attempts > limit) {
          rejectedHashes.add(ownerHash);
          while (rejectedHashes.size > CACHE_MAX) rejectedHashes.delete(rejectedHashes.values().next().value!);
          releaseQueueItem(ownerHash, item);
          trace("mo_add", item.el, ownerHash, "transport_drop", item.text);
          break;
        }
        part.retryAt = Date.now() + (error?.retry_after_ms ?? response.retry_after_ms
          ?? Math.min(TRANSPORT_RETRY_BASE_MS * 2 ** (part.attempts - 1), TRANSPORT_RETRY_MAX_MS));
      }
      finishQueueItem(ownerHash, item);
    }
  } catch {
    if (!controller.signal.aborted && generation === lifecycle) {
      const sources = new Map(selected.map(({ part }) => [part.hash, part.text]));
      for (const [ownerHash, item] of queue) {
        for (const part of item.parts) {
          if (part.translated !== undefined || sources.get(part.hash) !== part.text) continue;
          part.attempts++;
          if (part.attempts > TRANSPORT_MAX_RETRIES) { rejectedHashes.add(ownerHash); releaseQueueItem(ownerHash, item); break; }
          part.retryAt = Date.now() + Math.min(TRANSPORT_RETRY_BASE_MS * 2 ** (part.attempts - 1), TRANSPORT_RETRY_MAX_MS);
        }
      }
    }
  } finally {
    selected.forEach(({ part }) => { part.inFlight = false; });
    const released = new Map<string, string>();
    for (const { part } of selected) {
      if (chunkFlights.get(part.hash)?.controller !== controller) continue;
      chunkFlights.delete(part.hash);
      released.set(part.hash, part.text);
    }
    for (const item of queue.values()) {
      for (const part of item.parts) if (released.get(part.hash) === part.text) part.inFlight = false;
    }
    clearBatchCancellation(controller);
    activeRequests.delete(controller);
    batchOwners.delete(controller);
    if (active && generation === lifecycle && mode !== "off") {
      if (needsQueueRefill && queue.size < QUEUE_MAX - BATCH_SIZE * MAX_PARALLEL_BATCHES) {
        needsQueueRefill = false;
        observeNew(document.body, "rerun");
      }
      scheduleFlush(0);
    }
  }
}

// ── observers ─────────────────────────────────────────────────────────

let io: IntersectionObserver | null = null;

function makeIO() {
  io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = translationOwners.get(entry.target as HTMLElement) ?? entry.target as HTMLElement;
      const hash = el.getAttribute(HASH_ATTR);
      if (hash) {
        if (entry.isIntersecting) visibleHashes.add(hash); else visibleHashes.delete(hash);
        const item = queue.get(hash);
        if (item) item.visible = entry.isIntersecting && isActuallyVisible(el);
      }
      if (entry.isIntersecting) processCandidate(el, "io");
    }
    updateBatchCancellation();
    scheduleFlush(0);
    scheduleViewportPush();
  }, { rootMargin: `${VISIBLE_PRIORITY_MARGIN_PX}px`, threshold: 0 });
}

interface ScanTask { iterator: Generator<HTMLElement | null>; src: TraceSource }
const scanTasks = new Map<ParentNode, ScanTask>();
let scanTimer: number | null = null;
function cancelScanTasks() {
  if (scanTimer !== null) clearTimeout(scanTimer);
  scanTimer = null;
  scanTasks.clear();
}
function runScanTasks() {
  scanTimer = null;
  if (!active || mode === "off" || document.visibilityState === "hidden") { scanTasks.clear(); return; }
  const deadline = performance.now() + 4;
  let visited = 0;
  while (scanTasks.size && visited++ < 80 && performance.now() < deadline) {
    const [root, task] = scanTasks.entries().next().value!;
    if (root instanceof Node && !root.isConnected) { scanTasks.delete(root); continue; }
    const next = task.iterator.next();
    if (next.done) { scanTasks.delete(root); continue; }
    if (next.value) {
      io?.observe(next.value);
      if (isElementNearViewport(next.value)) processCandidate(next.value, task.src);
    }
  }
  if (scanTasks.size) scanTimer = window.setTimeout(runScanTasks, 16);
}
function observeNew(root: ParentNode, src: TraceSource = "init") {
  if (!io || !active || mode === "off" || document.visibilityState === "hidden") return;
  if (root instanceof HTMLElement && isLeafTextElement(root)) {
    const hash = hashText(normalizeForHash(sourceTextForTranslation(root)), TARGET_LANG);
    if (cache.has(hash)) { root.setAttribute(LEAF_ATTR, "1"); io.observe(root); processCandidate(root, "rerun"); return; }
  }
  // Coalesce overlapping mutation roots before walking. Ancestor class changes
  // may produce hundreds of records but still require one bounded scan.
  for (const existing of scanTasks.keys()) {
    if (existing === root || existing instanceof Node && root instanceof Node && existing.contains(root)) return;
    if (root instanceof Node && existing instanceof Node && root.contains(existing)) scanTasks.delete(existing);
  }
  scanTasks.set(root, { iterator: walkTranslatable(root), src });
  if (scanTimer === null) scanTimer = window.setTimeout(runScanTasks, 0);
}

function restoreRemovedTranslation(node: HTMLElement) {
  const owner = translationOwners.get(node);
  if (!owner?.isConnected || !active || mode === "off" || hasInjectedTranslation(owner)) return;
  const now = Date.now();
  const previous = repairWindows.get(owner);
  const hash = hashText(normalizeForHash(sourceTextForTranslation(owner)), TARGET_LANG);
  const state = previous && previous.hash === hash && now - previous.at < 2000 ? previous : { at: now, count: 0, hash };
  state.count++;
  repairWindows.set(owner, state);
  // Do not fight a framework that intentionally deletes the same generated
  // node every frame. It falls back once to stable source text instead.
  if (state.count > 3) return;
  processCandidate(owner, "rerun");
}

function observeMutations(root: ParentNode = document.body) {
  if (mo === null) {
    mo = new MutationObserver((records) => {
      // An ancestor class can change a descendant's computed display, and a
      // child insertion changes whether its parent is one inline paragraph.
      // Invalidating just the mutation target leaves those descendants stuck
      // in their previous hidden/layout state.
      if (records.some((record) => record.type === "attributes"
        && !(record.target instanceof HTMLElement && record.target.closest(`.${TR_CLASS}`)))) {
        hiddenCache = new WeakMap<HTMLElement, boolean>();
        inlineCache = new WeakMap<HTMLElement, boolean>();
      }
      multiCache = new WeakMap<HTMLElement, boolean>();
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
            if (isIgnoredElement(target)) {
              for (const leaf of target.querySelectorAll<HTMLElement>(`[${HASH_ATTR}], [${LEAF_ATTR}]`)) clearCandidateState(leaf);
            }
            const leaf = closestLeafElement(target);
            if (leaf) processCandidate(leaf, "mo_add");
            observeNew(target, "mo_add");
          }
          continue;
        }
        // display-more: some feeds replace text nodeValue directly
        // (characterData mutation, not childList). Only oldValue changes matter:
        // oldValue !== nodeValue 才触发 (filter noop), processCandidate parent 重 enqueue.
        if (r.type === "characterData") {
          if (r.oldValue === r.target.nodeValue) continue;
          const parent = r.target.parentElement;
          if (parent && parent instanceof HTMLElement) {
            // Ignore text changes inside injected translations.
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
          else if (Array.from(r.addedNodes).some((node) => node.nodeType === Node.TEXT_NODE)) observeNew(target, "mo_add");
        }

        for (const node of r.addedNodes) {
          // Skip nodes injected by this script to avoid self-trigger loops.
          if (skipMoNodes.has(node)) continue;
          // Structural sentinel: skip .bbt-tr even if WeakSet did not cover it,
          // for example after SPA cloning or another extension inserting it.
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

        // Release detached observer targets without reprocessing source text:
        // reprocessing removals would fight React's reconciliation. If only the
        // source was removed, its generated sibling must disappear with it.
        for (const node of r.removedNodes) {
          if (!(node instanceof HTMLElement) || node.isConnected) continue;
          if (isTranslationElement(node)) { restoreRemovedTranslation(node); continue; }
          for (const element of [node, ...node.querySelectorAll<HTMLElement>(`[${HASH_ATTR}], [${LEAF_ATTR}]`)]) {
            io?.unobserve(element);
            stableWindowMap.delete(element);
            injectedTranslations.get(element)?.remove();
            injectedTranslations.delete(element);
          }
        }
      }
      updateBatchCancellation();
    });
  }
  if (observedMutationRoots.has(root)) return;
  mo.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "translate", "contenteditable", "data-bbt-clean-read-active"],
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
//   only after a translation exists, so text is not hidden while waiting.
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
  active = true;
  const generation = ++lifecycle;
  document.addEventListener(TEARDOWN_EVENT, teardownAll);
  registerCleanup(() => document.removeEventListener(TEARDOWN_EVENT, teardownAll));

  injectModeStyle();
  void loadMode().then(() => {
    if (!active || generation !== lifecycle) return;
    applyModeAttr();
    makeIO();
    observeNew(document.body);
    observeMutations();
    setupAttentionWatchers();
    setupSelectionTranslator();
    startStableWindowTimer();
  });

  try {
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
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
        if (mode === "off") { cancelPageRequests(); cancelScanTasks(); }
        // bilingual ↔ replace 需要重绘 wrapper 形态: replace 用 native clone,
        // bilingual 用中性 font sibling; 译文本身仍走 L1 cache, 不重调 LLM.
        if (prev !== mode && mode !== "off") {
          rerenderCachedTranslations();
          // off → bilingual/replace: 之前没翻新内容, 触发 collect 走 cache hit / enqueue.
          observeNew(document.body, "rerun");
          scheduleFlush();
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
    /* extension context invalidated: wait for the next page load */
  }

  try {
    const onConfigurationChanged = (message: { type?: string; scope?: string }) => {
      if (message.type !== "babata.translation_config_changed" || message.scope === "transcription") return;
      cancelPageRequests();
      cache.clear();
      cacheBytes = 0;
      rejectedHashes.clear();
      sourceSnapshots = new WeakMap();
      repairWindows = new WeakMap();
      for (const root of translationRoots()) {
        for (const element of root.querySelectorAll<HTMLElement>(`[${HASH_ATTR}]`)) {
          if (hasInjectedTranslation(element)) refreshingElements.add(element);
          if (isElementNearViewport(element)) processCandidate(element, "rerun");
        }
      }
      document.dispatchEvent(new Event("babata:translation-config-changed"));
      observeNew(document.body, "rerun");
    };
    chrome.runtime.onMessage.addListener(onConfigurationChanged);
    registerCleanup(() => chrome.runtime.onMessage.removeListener(onConfigurationChanged));
  } catch { /* Extension reload can invalidate runtime listeners. */ }

  // F8: page unload / extension reload 时清 timer + MO, 防老 content script leak.
  window.addEventListener("pagehide", teardownAll, { once: true });
  registerCleanup(() => window.removeEventListener("pagehide", teardownAll));
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted && !extInvalidated) boot();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

export {};
