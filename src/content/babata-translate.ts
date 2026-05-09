/// <reference types="chrome" />

import DOMPurify from "dompurify";

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

const SAFE_HTML_OPTS = {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "code", "br", "span", "mark"],
  ALLOWED_ATTR: ["href", "title", "class"],
};

// LLM 翻一次, 永远 sibling .bbt-tr 注入. "替换/双语/不翻" 纯 CSS 切换 0 LLM (V 设计).
// 老 "auto" innerHTML 替换跟 React reconcile fundamentally 抢 DOM (X 实测同 leaf SPAN
// 10s 被外部 reconcile 9 次), 5 源 (沉浸式 v1.28.5/read-frog/kiss/fluentread/old-immersive)
// 全选 sibling 注入, 没人替换原文. 替换观感由 CSS hide leaf 元素实现, DOM 不抢.
type Mode = "off" | "bilingual" | "replace";

let mode: Mode = "bilingual";
const cache = new Map<string, string>();
interface QueueItem {
  el: HTMLElement;
  text: string;
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

// 子树根本不该进 (REJECT — TreeWalker 不再深入). 含已注入译文.
const EXCLUDE_SELECTOR = [
  "pre", "code", "script", "style", "noscript", "template",
  "svg", "math", "head", "title", "meta", "link",
  "input", "textarea", "select", "button",
  '[contenteditable="true"]', '[aria-hidden="true"]',
  `.${TR_CLASS}`,
].join(", ");

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
  | "stale_result" | "skip_no_text";
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

// periodic cleanup 防 Map leak (long timeline 累积). cleanupTimer 留 handle 给 lifecycle.
let cleanupTimer: number | null = null;
let mo: MutationObserver | null = null;
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
      cached = cs.display === "none" || cs.visibility === "hidden";
    } catch {
      cached = false;
    }
    hiddenCache.set(el, cached);
  }
  return cached;
}

// el 的 *祖先* (不含 self) 已被标 leaf — 该 ancestor 已整段翻, 不该再切子树重复翻.
// 用 closest 物理 DOM 遍历, 不用内存 WeakSet. el 被 page 删, 探测自动失效.
function hasLeafAncestor(el: HTMLElement): boolean {
  return !!el.parentElement?.closest(`[${LEAF_ATTR}]`);
}

function isTranslationElement(el: HTMLElement): boolean {
  return el.classList.contains(TR_CLASS);
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
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLeafTextElement(el: HTMLElement): boolean {
  // 直接子节点必须全是 text 或 inline 元素 + 含可视 text.
  let hasMeaningfulText = false;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || "").trim()) hasMeaningfulText = true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as HTMLElement;
      if (isTranslationElement(childEl) || childEl.querySelector(`.${TR_CLASS}`)) {
        return false;
      }
      if (!isInlineElement(childEl)) return false;
      if ((childEl.textContent || "").trim()) hasMeaningfulText = true;
    }
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
  const rootEl = root instanceof HTMLElement ? root : document.body;

  function visit(el: HTMLElement) {
    if (el.matches(EXCLUDE_SELECTOR)) return;
    // 祖先已 leaf (整段已包翻) → 子树不切. 物理 closest 遍历, 不依赖内存 lock.
    if (hasLeafAncestor(el)) return;
    if (isHidden(el)) return;

    const isInline = isInlineElement(el);
    const containsTranslation = hasTranslationChild(el);

    if (isInline) {
      // INLINE 标签自身仅在 leaf 时 ACCEPT (X 推 span / X article sibling 内容).
      // 子树不深入 (inline 内含 nested block 罕见, 接受 trade-off).
      if (!containsTranslation && isLeafTextElement(el)) {
        el.setAttribute(LEAF_ATTR, "1");
        result.push(el);
      }
      // 如果 inline parent 已含 babata 译文，不能把 parent 的原文+译文当
      // 一个新 leaf；下钻回原 source child，避免 X 上译文污染 hash。
      if (containsTranslation) {
        for (const child of Array.from(el.children)) {
          if (child instanceof HTMLElement) visit(child);
        }
      }
      return;
    }

    // block 候选: 多 inline 子且无 text 桥接 → 拆开各翻 (X 推/段落多段 case).
    if (isMultiSegmentInline(el)) {
      // outer SKIP, walker 进子让 inline 各 ACCEPT.
      for (const child of Array.from(el.children)) {
        if (child instanceof HTMLElement) visit(child);
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
  }

  visit(rootEl);
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

function shouldTranslate(text: string): boolean {
  if (!text || text.length < 4) return false;
  if (text.length > 4000) return false;
  // 输入框 placeholder / 示例文案常以 e.g. 开头。它们通常不是 DOM 正文文本,
  // 被页面用 overlay 渲染时强行注入会和原 placeholder 叠字；后续应走 attr 专用链.
  if (/^e\.g[.,]?\s+/i.test(text.trim())) return false;
  // X 上计数/倒计时会秒级 mutation；这些不是自然语言，翻译只会制造 stale_result
  // 和重复网络请求。保留含字母的混合文案，跳纯数字/时间/单位/handle/tag。
  if (/^[@#][\p{L}\p{N}_-]+$/u.test(text)) return false;
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

// ── inject ────────────────────────────────────────────────────────────

function clearTranslation(el: HTMLElement) {
  el.querySelectorAll(`:scope > .${TR_INPLACE_CLASS}`).forEach((node) => node.remove());
  const next = el.nextElementSibling;
  if (next && next.classList.contains(TR_CLASS)) {
    next.remove();
  }
}

function clearAllTranslations() {
  document.querySelectorAll(`.${TR_CLASS}`).forEach((node) => node.remove());
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

const PRESERVED_MEDIA_SELECTOR = [
  "svg", "img", "canvas", "video", "audio", "picture", "input", "textarea", "select", "button",
].join(", ");

function directInplaceTranslation(el: HTMLElement): Element | null {
  return el.querySelector(`:scope > .${TR_INPLACE_CLASS}`);
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

function hasPreservedMedia(el: HTMLElement): boolean {
  return !!el.querySelector(PRESERVED_MEDIA_SELECTOR);
}

function firstSourceTemplateClass(el: HTMLElement): HTMLElement | null {
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (isTranslationElement(child)) continue;
    if (child.classList.contains(SRC_CLASS)) return child;
  }
  return null;
}

function markInPlaceSource(el: HTMLElement): HTMLElement | null {
  let template: HTMLElement | null = firstSourceTemplateClass(el);
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!(child.textContent || "").trim()) continue;
      const wrapper = document.createElement("span");
      wrapper.className = SRC_CLASS;
      child.parentNode?.insertBefore(wrapper, child);
      wrapper.appendChild(child);
      skipMoNodes.add(wrapper);
      if (!template) template = wrapper;
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    if (isTranslationElement(child)) continue;
    if (!sourceText(child)) continue;
    if (hasPreservedMedia(child)) continue;
    child.classList.add(SRC_CLASS);
    if (!template) template = child;
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
  const safe = DOMPurify.sanitize(withBreaks, SAFE_HTML_OPTS);
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
  document.querySelectorAll(`[${HASH_ATTR}]`).forEach((node) => {
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

// ── candidate processing ──────────────────────────────────────────────

function processCandidate(el: HTMLElement, src: TraceSource = "init") {
  if (mode === "off") return;

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
  const hasInjected = hasInjectedTranslation(el);
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
  queue.set(fresh, { el, text });
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

function scheduleFlush() {
  if (flushInProgress) return;
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(flush, FLUSH_DEBOUNCE_MS);
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
  // FIFO 取 BATCH_SIZE — 不再按 viewport drop, V 滚出去的也翻完
  // ("能读取到的尽量都翻"). slice 暂不删, 等 round-trip 完按 network 状态决定.
  const slice: { hash: string; el: HTMLElement; text: string }[] = [];
  for (const [h, item] of queue) {
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
  }
  // SW / server 没 ready 或 extension reload → 整 slice 留 queue, scheduleFlush 下次重试.

  const byHash = new Map(slice.map((item) => [item.hash, item]));
  const staleRechecks: HTMLElement[] = [];
  for (const r of results) {
    const item = byHash.get(r.hash);
    if (!item || !r.translated) continue;
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
    // server 处理过 (即使部分 result 缺也算 LLM 已尝试), 删 slice 防 retry 浪费.
    for (const { hash } of slice) queue.delete(hash);
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
  // IO 现在仅用来追踪 visibleHashes (events.jsonl 的 page_memory 事实层).
  // 翻译触发已不再 gate 在 viewport — 全 schedule, IO 不再 trigger processCandidate.
  io = new IntersectionObserver(
    (entries) => {
      let viewportChanged = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const h = el.getAttribute(HASH_ATTR);
        if (!h) continue;
        if (e.isIntersecting) {
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
    { rootMargin: "200px", threshold: 0.01 },
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

function observeMutations() {
  if (mo !== null) return;
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
          if (target.hasAttribute(LEAF_ATTR)) {
            processCandidate(target, "mo_add");
          }
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
      // childList mutation: target 内部 children 变了, 但 target 自己 (= 已 leaf 的段落)
      // 没被显式 reprocess. X "显示更多" 用 React 替换 tweetText.children (整 child list
      // swap, 不走 characterData), target=tweetText 没动. 之前漏掉这条路径 = 展开后 text
      // 变了 hash 不变 (旧 hash attr 仍在), 永不 re-translate. 加这条让 leaf target 自检.
      if (target instanceof HTMLElement && target.hasAttribute(LEAF_ATTR)) {
        processCandidate(target, "mo_add");
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
  mo.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
  });
}

// ── boot ──────────────────────────────────────────────────────────────

function normalizeMode(v: unknown): Mode {
  // 老 "auto" → "replace" (UX 等价: 视觉上替换原文, 但走 sibling+CSS hide 不抢 DOM).
  if (v === "off") return "off";
  if (v === "auto" || v === "replace") return "replace";
  return "bilingual";
}

async function loadMode() {
  try {
    const got = await chrome.storage.local.get("babata.translation_mode");
    const stored = got["babata.translation_mode"];
    mode = normalizeMode(stored);
    // 老 "auto" 一次性迁移到 "replace" — widget UI radio 才能正确选中.
    if (stored === "auto") {
      void chrome.storage.local.set({ "babata.translation_mode": "replace" });
    }
  } catch {
    /* default bilingual */
  }
}

// CSS rules — mode 切换不重调 LLM, 只重绘 page-side cached translation nodes.
// 关键设计:
//   replace 用 `:has(+ .${TR_CLASS})` 避免空窗 — leaf 只在 sibling 译文已 inject 时
//   才隐藏, 翻译没回来前 leaf 仍显示原文 (V 反馈 "少了一大堆" = 之前无条件 hide).
//   replace 的 .bbt-tr-native 复制原 leaf tag/class/style/data state, 让站点原 CSS 决定
//   字号/间距/布局; bilingual 才用额外 display + border-left / 字号 / margin 装饰区分.
const MODE_STYLE_ID = "bbt-mode-style";
function injectModeStyle() {
  let style = document.getElementById(MODE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = MODE_STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = `
    .${TR_CLASS} { color: inherit; }
    html[data-bbt-mode="off"] .${TR_CLASS} { display: none !important; }
    html[data-bbt-mode="replace"] [${LEAF_ATTR}]:has(+ .${TR_CLASS}) { display: none !important; }
    html[data-bbt-mode="replace"] .${TR_NATIVE_CLASS} { color: inherit; }
    html[data-bbt-mode="replace"] [${INPLACE_ATTR}]:has(> .${TR_INPLACE_CLASS}) > .${SRC_CLASS} {
      display: none !important;
    }
    html[data-bbt-mode="replace"] [${INPLACE_ATTR}] > .${TR_INPLACE_CLASS} {
      color: inherit;
    }
    html[data-bbt-mode="bilingual"] .${TR_INLINE_CLASS} { display: inline; }
    html[data-bbt-mode="bilingual"] .${TR_BLOCK_CLASS} { display: block; }
    html[data-bbt-mode="bilingual"] .${TR_BLOCK_CLASS} {
      color: #5b5b5b;
      font-size: .95em;
      line-height: 1.5;
      margin-top: 3px;
      border-left: 2px solid #d8d2c5;
      padding-left: 8px;
    }
    html[data-bbt-mode="bilingual"] .${TR_INLINE_CLASS} {
      color: #5b5b5b;
      margin-left: 4px;
    }
  `;
}
function applyModeAttr() {
  document.documentElement.setAttribute("data-bbt-mode", mode);
}

function boot() {
  if (window.top !== window.self) return;
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
    startCleanupTimer();
    startStableWindowTimer();
  });

  try {
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes["babata.translation_mode"]) {
        const prev = mode;
        mode = normalizeMode(changes["babata.translation_mode"].newValue);
        applyModeAttr();
        // bilingual ↔ replace 需要重绘 wrapper 形态: replace 用 native clone,
        // bilingual 用中性 font sibling; 译文本身仍走 L1 cache, 不重调 LLM.
        if (prev !== mode && mode !== "off") {
          rerenderCachedTranslations();
          // off → bilingual/replace: 之前没翻新内容, 触发 collect 走 cache hit / enqueue.
          observeNew(document.body, "rerun");
        }
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
