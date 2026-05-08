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
const TR_CLASS = "bbt-tr";
const TR_STYLE =
  "display:block;color:#5b5b5b;font-size:.95em;line-height:1.5;margin-top:3px;border-left:2px solid #d8d2c5;padding-left:8px;";

const SAFE_HTML_OPTS = {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "code", "br", "span", "mark"],
  ALLOWED_ATTR: ["href", "title", "class"],
};

type Mode = "off" | "auto" | "bilingual";

let mode: Mode = "bilingual";
const cache = new Map<string, string>();
const queue = new Map<string, HTMLElement>();
let flushTimer: number | null = null;

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
  document.addEventListener("visibilitychange", () => {
    pushAttention({ kind: "attention", visibility: document.visibilityState });
  });
  window.addEventListener("focus", () => pushAttention({ kind: "attention", focus: "yes" }));
  window.addEventListener("blur", () => pushAttention({ kind: "attention", focus: "no" }));

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
  ["mousemove", "keydown", "scroll", "click", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, onInteract, { passive: true }),
  );
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

// claimed = 已被 walker ACCEPT 的 leaf, 子树整个 skip 防重复. WeakSet 不 leak DOM ref.
const claimed = new WeakSet<HTMLElement>();
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
// 抄沉浸式 `a Set` (content_main_beauty.js:45373) — element in-flight 锁. 当 el 已 enqueue
// 在 server LLM 调用中, 新 mutation 不重 enqueue (queue Map 是 hash-keyed, hash 变会重复
// 进 queue 触发 server 多次调). flush results 完成后清, 允许下次 mutation 触发新翻.
const inFlightElements = new WeakSet<HTMLElement>();
// X 干掉 .bbt-tr 但 source 仍在 DOM (主推漏翻 case): 200ms trailing 后再 inject.
const REINJECT_DELAY_MS = 200;

// ── client trace instrumentation (V "开发要收集数据方便调试") ─
// 每次 processCandidate 在每个 decision 点记一条 trace. batch flush 经 SW POST
// /translate_trace, server 写 events.jsonl client_trace kind. V tail 直接看
// 每个 decision 不再 hypothesize 闪烁/漏翻 root cause.
type TraceSource = "io" | "mo_add" | "mo_char" | "rerun" | "init";
type TraceDecision = "throttle" | "not_translatable" | "already" | "debounce"
  | "cache_inject" | "enqueue" | "reinject_timer" | "skip_no_text";
interface TraceRecord {
  ts: number;
  src: TraceSource;
  dec: TraceDecision;
  hash: string;
  txt: string;
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
  traces.push({
    ts: Date.now(),
    src, dec, hash,
    txt: (text ?? el.innerText ?? el.textContent ?? "").trim().slice(0, 40),
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
  flushTraces();  // 刷尾巴 trace 不丢 (extension reload / pagehide).
  if (traceTimer !== null) {
    clearTimeout(traceTimer);
    traceTimer = null;
  }
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

function hasClaimedAncestor(el: HTMLElement): boolean {
  let p = el.parentElement;
  while (p) {
    if (claimed.has(p)) return true;
    p = p.parentElement;
  }
  return false;
}

function isLeafTextElement(el: HTMLElement): boolean {
  // 直接子节点必须全是 text 或 inline 元素 + 含可视 text.
  let hasMeaningfulText = false;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || "").trim()) hasMeaningfulText = true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (!isInlineElement(child as HTMLElement)) return false;
      if ((child.textContent || "").trim()) hasMeaningfulText = true;
    }
  }
  if (!hasMeaningfulText) return false;
  const text = (el.innerText || el.textContent || "").trim();
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
      if (!isInlineElement(c as HTMLElement)) return false;
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
  const rootEl = root instanceof Element ? root : document.body;

  function visit(el: HTMLElement) {
    if (el.matches(EXCLUDE_SELECTOR)) return;
    if (hasClaimedAncestor(el)) return;
    if (isHidden(el)) return;

    const isInline = isInlineElement(el);

    if (isInline) {
      // INLINE 标签自身仅在 leaf 时 ACCEPT (X 推 span / X article sibling 内容).
      // 子树不深入 (inline 内含 nested block 罕见, 接受 trade-off).
      if (isLeafTextElement(el)) {
        claimed.add(el);
        result.push(el);
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
      claimed.add(el);
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
  return detectLang(text) !== "zh";
}

// ── hash (FNV-1a-ish 64bit, 16 hex chars) ─────────────────────────────

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
  const next = el.nextElementSibling;
  if (next && next.classList.contains(TR_CLASS)) {
    next.remove();
  }
}

function injectTranslation(el: HTMLElement, raw: string, hash?: string) {
  clearTranslation(el);
  if (mode === "off" || !raw) return;
  // 译文等于原文 (模型决定不翻 — 专有名词 / handle / 版本号等) → 不 inject sibling,
  // 否则视觉上原文显示 2 遍 (V 截图 #8 user info 重复 3 次的 root cause).
  const original = (el.innerText || el.textContent || "").trim();
  if (raw.trim() === original) return;
  // server 返 plain text with \n\n 段分隔. 浏览器把 \n 当 whitespace 渲染,
  // 段间会粘连, 转 <br><br> 才有视觉换行 (DOMPurify allowlist 含 br).
  const withBreaks = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
  const safe = DOMPurify.sanitize(withBreaks, SAFE_HTML_OPTS);
  if (mode === "auto") {
    Reflect.set(el, "innerHTML", safe);
    // F4: innerHTML 替换后子树都是我们的 sanitized 译文 (含允许的 span/mark/a 等),
    // 不 mark 的话 MO addedNodes 看到这些 inline 子树会重新 collect → 假性"原文"翻译.
    el.querySelectorAll("*").forEach((c) => skipMoNodes.add(c));
    if (hash) recentlyInjected.set(hash, Date.now());
    return;
  }
  const font = document.createElement("font");
  font.className = TR_CLASS;
  font.setAttribute("style", TR_STYLE);
  Reflect.set(font, "innerHTML", safe);
  // MO sentinel: 自己 inject 的 font 加进 skipMoNodes, MO addedNodes 看到跳 (防自触发).
  skipMoNodes.add(font);
  el.insertAdjacentElement("afterend", font);
  if (hash) recentlyInjected.set(hash, Date.now());
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
  const text = (el.innerText || el.textContent || "").trim();
  if (!text) {
    trace(src, el, "", "skip_no_text");
    return;
  }
  if (!shouldTranslate(text)) {
    trace(src, el, "", "not_translatable", text);
    return;
  }

  const fresh = hashText(text, TARGET_LANG);
  const existing = el.getAttribute(HASH_ATTR);

  // SPA 重 mount 时, 旧 .bbt-tr sibling 可能跟随 hash 节点带过来; 但 text 已变 →
  // hash 不一致 → 旧译文跟新内容不对应, 必须清掉重翻.
  const next = el.nextElementSibling;
  const hasInjected = !!(next && next.classList.contains(TR_CLASS));
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

  trace(src, el, fresh, "enqueue", text);
  inFlightElements.add(el);
  queue.set(fresh, el);
  // queue cap — V 快速滚时 evict 最老 (FIFO insertion order).
  if (queue.size > QUEUE_MAX) {
    const oldest = queue.keys().next().value as string | undefined;
    if (oldest && oldest !== fresh) queue.delete(oldest);
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(flush, FLUSH_DEBOUNCE_MS);
}

async function flush() {
  flushTimer = null;
  if (queue.size === 0) return;

  // FIFO 取 BATCH_SIZE — 不再按 viewport drop, V 滚出去的也翻完
  // ("能读取到的尽量都翻"). slice 暂不删, 等 round-trip 完按 network 状态决定.
  const slice: { hash: string; el: HTMLElement }[] = [];
  for (const [h, el] of queue) {
    slice.push({ hash: h, el });
    if (slice.length >= BATCH_SIZE) break;
  }
  if (slice.length === 0) return;

  const batch = slice.map(({ hash, el }) => ({
    hash,
    text: (el.innerText || el.textContent || "").trim(),
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

  const byHash = new Map(slice.map(({ hash, el }) => [hash, el]));
  for (const r of results) {
    const el = byHash.get(r.hash);
    if (!el || !r.translated) continue;
    cache.set(r.hash, r.translated);
    injectTranslation(el, r.translated, r.hash);
  }

  if (networkOk) {
    // server 处理过 (即使部分 result 缺也算 LLM 已尝试), 删 slice 防 retry 浪费.
    for (const { hash } of slice) queue.delete(hash);
  }
  // 不管 networkOk 与否, slice 里 element 释放 in-flight 锁 (allow 下次 mutation 触发新翻).
  for (const { el } of slice) inFlightElements.delete(el);
  if (queue.size > 0) scheduleFlush();
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

      // F6: X SPA 干掉 .bbt-tr 但 source 仍在 DOM (主推漏翻 case).
      // previousSibling 是 hashed source 时, 200ms trailing 后 re-inject (cache 命中不调 server).
      // 200ms 让 X 这一波 reconcile burst 走完, source 仍在则补译文; 不在则 noop.
      for (const node of r.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (!node.classList.contains(TR_CLASS)) continue;
        const source = r.previousSibling;
        if (!(source instanceof HTMLElement)) continue;
        if (!source.hasAttribute(HASH_ATTR)) continue;
        const hash = source.getAttribute(HASH_ATTR);
        if (!hash) continue;
        const cached = cache.get(hash);
        if (cached === undefined) continue;
        // 不 delete recentlyInjected — 删了会让 200ms 内 addedNodes 路径 processCandidate
        // 跳过 800ms debounce 抢先 inject + setTimeout 200ms 后又 inject = double.
        // 让 800ms debounce 自然挡 addedNodes; setTimeout 内 sibling check 兜底.
        window.setTimeout(() => {
          if (!source.isConnected) return;
          if (source.nextElementSibling?.classList?.contains(TR_CLASS)) return;
          // re-validate: text 仍是当时的 hash, 避免 X 重 mount 后 text 变了
          const text = (source.innerText || source.textContent || "").trim();
          if (hashText(text, TARGET_LANG) !== hash) return;
          trace("mo_add", source, hash, "reinject_timer", text);
          injectTranslation(source, cached, hash);
        }, REINJECT_DELAY_MS);
      }
    }
  });
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
  });
}

// ── boot ──────────────────────────────────────────────────────────────

async function loadMode() {
  try {
    const got = await chrome.storage.local.get("babata.translation_mode");
    if (got["babata.translation_mode"]) {
      mode = got["babata.translation_mode"] as Mode;
    }
  } catch {
    /* default bilingual */
  }
}

function rerunAll() {
  document.querySelectorAll(`.${TR_CLASS}`).forEach((e) => e.remove());
  // F5: V 显式 toggle mode 是 user action, 清 debounce 让 processCandidate 立即 re-inject.
  recentlyInjected.clear();
  if (mode === "off") return;
  document.querySelectorAll(`[${HASH_ATTR}]`).forEach((e) => {
    if (e instanceof HTMLElement) processCandidate(e, "rerun");
  });
}

function boot() {
  if (window.top !== window.self) return;
  const w = window as unknown as { __babataTranslateBooted?: boolean };
  if (w.__babataTranslateBooted) return;
  w.__babataTranslateBooted = true;

  void loadMode().then(() => {
    makeIO();
    observeNew(document.body);
    observeMutations();
    setupAttentionWatchers();
    startCleanupTimer();
    startStableWindowTimer();
  });

  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes["babata.translation_mode"]) {
        mode = changes["babata.translation_mode"].newValue as Mode;
        rerunAll();
      }
    });
  } catch {
    /* extension context invalidated — 老 content script 不 re-bind, V 刷 page 后新 SC 接手 */
  }

  // F8: page unload / extension reload 时清 timer + MO, 防老 content script leak.
  window.addEventListener("pagehide", teardownAll, { once: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

export {};
