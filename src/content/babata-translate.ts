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
const BATCH_SIZE = 8;
const FLUSH_DEBOUNCE_MS = 300;
// V 快速滚 feed 时 queue 不能无限长. 超 cap 时 evict 最老 (insertion order).
const QUEUE_MAX = 60;

// ── attention / viewport (page-side state push) ───────────────────────
const visibleHashes = new Set<string>();
let viewportPushTimer: number | null = null;
let lastInteractAt = Date.now();
let isIdle = false;
let idleTimer: number | null = null;
const IDLE_THRESHOLD_MS = 30_000;
const VIEWPORT_PUSH_DEBOUNCE_MS = 1000;

function pushAttention(payload: Record<string, unknown>) {
  void chrome.runtime
    .sendMessage({ type: "babata.attention", url: location.href, ...payload })
    .catch(() => {});
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

// ── site-specific selector (V0 写死, 后续走 site profile JSON) ─────────

function paragraphSelectors(): string[] {
  const h = location.hostname;
  if (h === "x.com" || h === "twitter.com" || h.endsWith(".x.com")) {
    // :not(:has(...)) — 推特转推 quoted 块嵌套 tweetText 时, 只翻最 leaf 级别,
    // 不让 outer (含 quoted 内容) 跟 inner 同时翻 (避免重复 + outer text 太长 fail).
    return ['[data-testid="tweetText"]:not(:has([data-testid="tweetText"]))'];
  }
  if (h === "github.com") {
    return [".markdown-body p", ".markdown-body li", ".comment-body p", ".comment-body li"];
  }
  if (h.endsWith("youtube.com")) {
    return ["#description-inner span.yt-core-attributed-string", "#title yt-formatted-string"];
  }
  if (h === "news.ycombinator.com") {
    return [".commtext", ".titleline > a"];
  }
  if (h.endsWith("reddit.com")) {
    return ['[slot="text-body"] p', "shreddit-post h1", ".md p", ".md li"];
  }
  return ["article p", "article li", "main p", "main li", "[role=main] p", "[role=article] p"];
}

// 注意: 不能写 `[${HASH_ATTR}] *` — 会让 nested 翻译目标 (推特 quoted 推) 被
// outer 排除. 重复翻译靠 processCandidate 的 nextElementSibling 检查防止.
const EXCLUDE_SELECTOR = `pre, code, script, style, [contenteditable="true"], .${TR_CLASS}`;

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

function injectTranslation(el: HTMLElement, raw: string) {
  clearTranslation(el);
  if (mode === "off" || !raw) return;
  // server 返 plain text with \n\n 段分隔. 浏览器把 \n 当 whitespace 渲染,
  // 段间会粘连, 转 <br><br> 才有视觉换行 (DOMPurify allowlist 含 br).
  const withBreaks = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
  const safe = DOMPurify.sanitize(withBreaks, SAFE_HTML_OPTS);
  if (mode === "auto") {
    Reflect.set(el, "innerHTML", safe);
    return;
  }
  const font = document.createElement("font");
  font.className = TR_CLASS;
  font.setAttribute("style", TR_STYLE);
  Reflect.set(font, "innerHTML", safe);
  el.insertAdjacentElement("afterend", font);
}

// ── candidate processing ──────────────────────────────────────────────

function processCandidate(el: HTMLElement) {
  if (mode === "off") return;
  const next = el.nextElementSibling;
  if (next && next.classList.contains(TR_CLASS)) return;

  const text = (el.innerText || el.textContent || "").trim();
  if (!shouldTranslate(text)) return;

  const fresh = hashText(text, TARGET_LANG);
  const existing = el.getAttribute(HASH_ATTR);
  if (existing !== fresh) {
    el.setAttribute(HASH_ATTR, fresh);
  }

  const cached = cache.get(fresh);
  if (cached !== undefined) {
    injectTranslation(el, cached);
    return;
  }

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

  // 视口优先: 当前可见的段先翻; 已 scroll-out 的丢 (V 滚过去了, 浪费算力).
  // 如果之后 V 滚回去, MutationObserver/IO 重 fire 会重入 queue.
  const slice: { hash: string; el: HTMLElement }[] = [];
  const drop: string[] = [];
  for (const [h, el] of queue) {
    if (visibleHashes.has(h)) {
      slice.push({ hash: h, el });
      if (slice.length >= BATCH_SIZE) break;
    } else {
      drop.push(h);
    }
  }
  for (const h of drop) queue.delete(h);
  for (const { hash } of slice) queue.delete(hash);
  if (queue.size > 0) scheduleFlush();
  if (slice.length === 0) return;

  const batch = slice.map(({ hash, el }) => ({
    hash,
    text: (el.innerText || el.textContent || "").trim(),
  }));

  let results: { hash: string; translated: string }[] = [];
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: "babata.translate",
      site: location.hostname,
      url: location.href,
      target: TARGET_LANG,
      batch,
    })) as { ok: boolean; results?: typeof results } | undefined;
    if (resp?.ok && Array.isArray(resp.results)) {
      results = resp.results;
    }
  } catch {
    // SW / server 没 ready — 静默. 段落 hash 仍在 DOM, 下次 IO/MO 触发会重入 queue.
    return;
  }

  const byHash = new Map(slice.map(({ hash, el }) => [hash, el]));
  for (const r of results) {
    const el = byHash.get(r.hash);
    if (!el || !r.translated) continue;
    cache.set(r.hash, r.translated);
    injectTranslation(el, r.translated);
  }
}

// ── observers ─────────────────────────────────────────────────────────

let io: IntersectionObserver | null = null;

function makeIO() {
  io = new IntersectionObserver(
    (entries) => {
      let viewportChanged = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting) {
          processCandidate(el);
          const h = el.getAttribute(HASH_ATTR);
          if (h && !visibleHashes.has(h)) {
            visibleHashes.add(h);
            viewportChanged = true;
          }
        } else {
          const h = el.getAttribute(HASH_ATTR);
          if (h && visibleHashes.delete(h)) {
            viewportChanged = true;
          }
        }
      }
      if (viewportChanged) scheduleViewportPush();
    },
    { rootMargin: "200px", threshold: 0.01 },
  );
}

function observeNew(root: ParentNode) {
  if (!io) return;
  const sels = paragraphSelectors().join(", ");
  let nodes: NodeListOf<Element>;
  try {
    nodes = root.querySelectorAll(sels);
  } catch {
    return;
  }
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.closest(EXCLUDE_SELECTOR)) continue;
    io.observe(el);
  }
}

function observeMutations() {
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // 重 mount 的原段落带 hash → 立即 L1 cache 命中 re-inject.
        if (node.hasAttribute(HASH_ATTR)) {
          processCandidate(node);
        }
        const hashed = node.querySelectorAll(`[${HASH_ATTR}]`);
        for (const h of hashed) {
          if (h instanceof HTMLElement) processCandidate(h);
        }

        // 新加段落 → 加入 IO 观察 (viewport 入境再翻).
        observeNew(node);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
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
  if (mode === "off") return;
  document.querySelectorAll(`[${HASH_ATTR}]`).forEach((e) => {
    if (e instanceof HTMLElement) processCandidate(e);
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
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes["babata.translation_mode"]) {
      mode = changes["babata.translation_mode"].newValue as Mode;
      rerunAll();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

export {};
