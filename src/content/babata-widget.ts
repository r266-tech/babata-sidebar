/// <reference types="chrome" />

import avatarUrl from "../assets/babata-avatar.png";
import {
  STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
  STORAGE_ALWAYS_TRANSLATE_HOSTS,
  STORAGE_SELECTION_TRANSLATION,
  STORAGE_TRANSLATION_MODE as STORAGE_MODE,
  effectiveTranslationModeForHost,
  isAlwaysTranslateHost,
  normalizeHostList,
  normalizeHostname,
  normalizeTranslationRenderMode as normalizeMode,
  type TranslationRenderMode,
  updateAlwaysTranslateHostState,
} from "../translation-settings";

// babata 桌宠 floating widget — 可拖拽圆形按钮 + 设置弹窗 + 主动 bubble.
//
// 哲学: 内容物 LLM 决定 (bubble 文本 / 翻译要不要做), widget 只是容器.
// Shadow DOM 物理隔离站点 CSS, all:initial 防 site reset 干扰.
//
// V0 元素:
//   主按钮 (drag-able, 单击 = 打开 page chat popup + prompt chips; 双击 = agent 锐评; 三击 = 净化阅读)
//   设置按钮 (渲染模式 + 当前站点是否翻译)
//   bubble (server 推 mascot_speak 时浮起来, 30s auto-dismiss, V 点 X 关掉)

type OpenChatPopupOptions = { suggest?: boolean };
type BubbleOptions = {
  tone?: "normal" | "thinking";
  dismissible?: boolean;
  interactive?: boolean;
};

const HOST_ID = "__babata_widget_host__";
const TEARDOWN_EVENT = "babata:widget-teardown";
const STORAGE_POS = "babata.widget.pos";
const CLEAN_READ_STYLE_ID = "__babata_clean_read_style__";
const CLEAN_READ_ROOT_ID = "__babata_clean_read_root__";
const DEFAULT_MODE: TranslationRenderMode = "replace";
const DEFAULT_SELECTION_TRANSLATION_ENABLED = false;
const MAIN_SINGLE_CLICK_DELAY_MS = 500;
const AGENT_VIEW_THINKING_TEXT = "思考中…";
const CLEAN_READ_THINKING_TEXT = "正在净读…";
const AGENT_VIEW_THINKING_DURATION_MS = 12_000;
const BUBBLE_GAP_PX = 12;
const BUBBLE_VIEWPORT_PADDING_PX = 12;
const BUBBLE_MAX_WIDTH_PX = 360;

interface WidgetPos {
  right: number;
  top: number;
}

type ChatPopupElement = HTMLDivElement & { cleanup?: () => void };
type CleanReadOverlayElement = HTMLDivElement & { cleanup?: () => void };
type CleanReadBlockKind = "heading" | "paragraph" | "quote" | "code";
type CleanReadBlock = { kind: CleanReadBlockKind; text: string };
type CleanReadSnapshot = { el: HTMLElement; html: string; style: string | null };

const DEFAULT_POS: WidgetPos = { right: 18, top: 0.5 }; // top 比例 (0-1)

let widgetState: {
  shadow: ShadowRoot;
  root: HTMLDivElement;
  mainAnchor: HTMLDivElement;
  bubbleSlot: HTMLDivElement;
  bubble: HTMLDivElement | null;
  bubbleHideTimer: number | null;
  openChatPopup: ((opts?: OpenChatPopupOptions) => void) | null;
  mode: TranslationRenderMode;
  selectionTranslationEnabled: boolean;
  alwaysTranslateHosts: string[];
  alwaysTranslateDisabledHosts: string[];
  currentHost: string;
  pos: WidgetPos;
} | null = null;
let cleanupCurrentWidget: (() => void) | null = null;
let extInvalidated = false;

function isInvalidatedError(e: unknown): boolean {
  return /Extension context invalidated/.test((e as Error)?.message ?? String(e));
}

function handleInvalidatedContext() {
  extInvalidated = true;
  cleanupCurrentWidget?.();
}

function safeChromePromise<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (extInvalidated) return Promise.resolve(undefined);
  try {
    return fn().catch((e) => {
      if (isInvalidatedError(e)) handleInvalidatedContext();
      return undefined;
    });
  } catch (e) {
    if (isInvalidatedError(e)) handleInvalidatedContext();
    return Promise.resolve(undefined);
  }
}

function safeChromeCall<T>(fn: () => T): T | undefined {
  if (extInvalidated) return undefined;
  try {
    return fn();
  } catch (e) {
    if (isInvalidatedError(e)) handleInvalidatedContext();
    return undefined;
  }
}

function applyPos(root: HTMLElement, pos: WidgetPos) {
  root.style.right = `${pos.right}px`;
  root.style.top = `${pos.top * window.innerHeight}px`;
}

function refreshBubbleMetrics() {
  if (!widgetState) return;
  const anchorRect = widgetState.mainAnchor.getBoundingClientRect();
  const availableLeft = anchorRect.left - BUBBLE_GAP_PX - BUBBLE_VIEWPORT_PADDING_PX;
  const maxWidth = Math.max(80, Math.min(BUBBLE_MAX_WIDTH_PX, Math.floor(availableLeft)));
  widgetState.mainAnchor.style.setProperty("--bubble-max-width", `${maxWidth}px`);
}

async function loadPersisted(): Promise<{
  mode: TranslationRenderMode;
  selectionTranslationEnabled: boolean;
  alwaysTranslateHosts: string[];
  alwaysTranslateDisabledHosts: string[];
  currentHost: string;
  pos: WidgetPos;
}> {
  const currentHost = normalizeHostname(location.hostname);
  const got = await safeChromePromise(() =>
    chrome.storage.local.get([
      STORAGE_MODE,
      STORAGE_SELECTION_TRANSLATION,
      STORAGE_ALWAYS_TRANSLATE_HOSTS,
      STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
      STORAGE_POS,
    ])
  );
  if (!got) {
    return {
      mode: DEFAULT_MODE,
      selectionTranslationEnabled: DEFAULT_SELECTION_TRANSLATION_ENABLED,
      alwaysTranslateHosts: [],
      alwaysTranslateDisabledHosts: [],
      currentHost,
      pos: DEFAULT_POS,
    };
  }
  return {
    mode: normalizeMode(got[STORAGE_MODE]),
    selectionTranslationEnabled: got[STORAGE_SELECTION_TRANSLATION] === true,
    alwaysTranslateHosts: normalizeHostList(got[STORAGE_ALWAYS_TRANSLATE_HOSTS]),
    alwaysTranslateDisabledHosts: normalizeHostList(got[STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS]),
    currentHost,
    pos: (got[STORAGE_POS] as WidgetPos) || DEFAULT_POS,
  };
}

function svg(d: string, opts: { size?: number; stroke?: number } = {}): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  const size = opts.size ?? 16;
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("viewBox", `0 0 16 16`);
  s.setAttribute("fill", "none");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", String(opts.stroke ?? 1.6));
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.appendChild(p);
  return s;
}

function avatar(className: string, alt: string): HTMLImageElement {
  const img = document.createElement("img");
  const extensionPath = avatarUrl.replace(/^\//, "");
  img.className = className;
  img.src = safeChromeCall(() => chrome.runtime.getURL(extensionPath)) ?? avatarUrl;
  img.alt = alt;
  img.draggable = false;
  return img;
}

function createWidget() {
  // 当前 frame 是顶 frame 才注入 (避免 iframe 内重复 widget).
  if (window.top !== window.self) return;
  if (!document.documentElement) return;

  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .widget {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
      --bubble-gap: ${BUBBLE_GAP_PX}px;
      --bubble-max-width: min(${BUBBLE_MAX_WIDTH_PX}px, calc(100vw - 96px));
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      color: #1c1c1c;
      pointer-events: auto;
      user-select: none;
    }
    .main-anchor {
      position: relative;
      width: 56px;
      height: 56px;
      flex: 0 0 56px;
    }
    .btn {
      width: 56px; height: 56px; border-radius: 999px;
      border: 1px solid rgba(0,0,0,.06);
      background: #ffffff;
      box-shadow: 0 4px 14px rgba(0,0,0,.10), 0 1px 3px rgba(0,0,0,.06);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      color: #c66a4a;
      transition: transform .12s, box-shadow .12s, background .12s;
    }
    .btn:hover { background: #faf9f7; box-shadow: 0 6px 18px rgba(0,0,0,.14); }
    .btn:active { transform: scale(.94); }
    .btn.dragging { cursor: grabbing; opacity: .85; }
    .btn-main {
      overflow: hidden;
      padding: 0;
    }
    .btn-secondary { width: 50px; height: 50px; }
    .avatar-main {
      width: 100%;
      height: 100%;
      border-radius: 999px;
      object-fit: cover;
      display: block;
    }

    /* secondary 默认折叠 — 仅主按钮可见; hover widget 或弹层打开时浮现.
       仍保留 layout 高度, hover 命中区域稳定不闪烁 (visibility:hidden 占位). */
    .btn-collapsible {
      opacity: 0;
      transform: translateY(-10px) scale(.55);
      pointer-events: none;
      transition: opacity .16s ease, transform .18s cubic-bezier(.34,1.5,.64,1);
    }
    .widget:hover .btn-collapsible,
    .widget.expanded .btn-collapsible {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }

    /* chat popup 打开时, 整个外部浮动 widget 隐藏 — b logo 已"进入" chat header. */
    .widget.chat-open {
      opacity: 0;
      pointer-events: none;
      transition: opacity .15s ease;
    }

    /* widget 隐藏 X — hover widget 时浮现在左上, 点击隐藏整个 widget. */
    .btn-close {
      position: absolute;
      left: -6px;
      top: -6px;
      width: 18px; height: 18px;
      border-radius: 999px;
      background: rgba(60,60,60,.7);
      color: #fff;
      border: 0;
      cursor: pointer;
      opacity: 0;
      transition: opacity .15s, background .12s, transform .12s;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      z-index: 1;
    }
    .widget:hover .btn-close,
    .widget.expanded .btn-close {
      opacity: 1;
    }
    .btn-close:hover { background: rgba(0,0,0,.85); transform: scale(1.1); }

    .bubble-slot {
      position: absolute;
      right: calc(100% + var(--bubble-gap));
      top: 0;
      width: var(--bubble-max-width);
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      pointer-events: none;
      z-index: 2;
    }
    .bubble {
      box-sizing: border-box;
      max-width: 100%;
      background: #1c1c1c;
      color: #f5f1eb;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
      position: relative;
      cursor: pointer;
      pointer-events: auto;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      user-select: text;
    }
    .bubble-thinking {
      max-width: 120px;
      padding: 8px 12px;
      background: rgba(28,28,28,.92);
      font-size: 12px;
      letter-spacing: 0;
      cursor: default;
    }
    .bubble::after {
      content: "";
      position: absolute;
      right: -6px; top: 23px;
      width: 0; height: 0;
      border-left: 6px solid #1c1c1c;
      border-top: 5px solid transparent;
      border-bottom: 5px solid transparent;
    }
    .bubble-close {
      position: absolute;
      right: -8px; top: -8px;
      width: 18px; height: 18px;
      border-radius: 999px;
      background: #6e6b66;
      color: #fff;
      font-size: 11px;
      line-height: 18px;
      text-align: center;
      cursor: pointer;
      border: 0;
      padding: 0;
    }

    .popover {
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 8px 28px rgba(0,0,0,.16);
      border: 1px solid rgba(0,0,0,.06);
      padding: 14px 16px;
      min-width: 220px;
    }
    .popover h4 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: #1c1c1c; }
    .popover label {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px; padding: 6px 0; cursor: pointer;
    }
    .popover input[type=radio],
    .popover input[type=checkbox] { margin: 4px 0 0 0; accent-color: #c66a4a; }
    .popover .divider { height: 1px; background: rgba(0,0,0,.08); margin: 8px 0; }

    .stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
    }

    .chat-popup {
      position: fixed;
      width: 380px;
      height: 560px;
      background: #faf9f7;
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 4px 12px rgba(0,0,0,.06);
      border: 1px solid rgba(0,0,0,.06);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      z-index: 2147483646;
    }
    .chat-popup-header {
      height: 36px;
      display: flex; align-items: center;
      padding: 0 6px 0 10px;
      gap: 8px;
      background: #f3efe6;
      border-bottom: 1px solid rgba(0,0,0,.05);
      cursor: grab;
      user-select: none;
    }
    .chat-popup-header.grabbing { cursor: grabbing; }
    .chat-popup-header .header-left {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 6px;
      font-size: 12.5px; color: #1c1c1c;
    }
    .chat-popup-header .header-left .avatar-mini {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .chat-popup-header .header-left .label { font-weight: 600; }
    .chat-popup-header .header-tools {
      display: flex; gap: 2px;
    }
    .chat-popup-header .icon-btn {
      width: 24px; height: 24px;
      border: 0; background: transparent;
      color: #6e6b66; cursor: pointer;
      border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
    }
    .chat-popup-header .icon-btn:hover { background: rgba(0,0,0,.06); color: #1c1c1c; }
    .chat-popup iframe {
      flex: 1; width: 100%; border: 0; display: block;
    }

    .clean-read-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      background: rgba(250,249,247,.96);
      display: flex;
      justify-content: center;
      align-items: stretch;
      box-sizing: border-box;
      padding: 28px;
      pointer-events: auto;
      user-select: text;
    }
    .clean-read-shell {
      width: min(920px, 100%);
      max-height: 100%;
      background: #fff;
      border: 1px solid rgba(0,0,0,.08);
      border-radius: 14px;
      box-shadow: 0 18px 60px rgba(0,0,0,.18);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .clean-read-head {
      flex: 0 0 auto;
      min-height: 46px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px 8px 16px;
      background: #f3efe6;
      border-bottom: 1px solid rgba(0,0,0,.06);
    }
    .clean-read-title {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      font-weight: 650;
      color: #1c1c1c;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .clean-read-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .clean-read-btn {
      height: 30px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #6e6b66;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      font-size: 12px;
    }
    .clean-read-btn:hover { background: rgba(0,0,0,.06); color: #1c1c1c; }
    .clean-read-icon {
      width: 30px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }
    .clean-read-body {
      flex: 1;
      overflow: auto;
      padding: 30px 34px 44px;
      font-size: 16px;
      line-height: 1.78;
      color: #1c1c1c;
      letter-spacing: 0;
    }
    .clean-read-body h1 {
      margin: 0 0 18px;
      font-size: 24px;
      line-height: 1.3;
      font-weight: 760;
      letter-spacing: 0;
    }
    .clean-read-body h2 {
      margin: 28px 0 10px;
      padding-top: 12px;
      border-top: 1px solid rgba(0,0,0,.08);
      font-size: 18px;
      line-height: 1.35;
      font-weight: 720;
      letter-spacing: 0;
    }
    .clean-read-body p { margin: 0 0 14px; }
    .clean-read-body ul { margin: 0 0 16px 22px; padding: 0; }
    .clean-read-body li { margin: 5px 0; padding-left: 2px; }
    .clean-read-body blockquote {
      margin: 14px 0;
      padding: 8px 14px;
      border-left: 3px solid #c66a4a;
      background: #faf7f0;
      color: #3c3832;
    }
    .clean-read-body pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #1f1f1f;
      color: #f5f1eb;
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.55;
    }
    @media (max-width: 720px) {
      .clean-read-overlay { padding: 0; }
      .clean-read-shell { border-radius: 0; border-left: 0; border-right: 0; }
      .clean-read-body { padding: 22px 18px 34px; font-size: 15px; }
    }
  `;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "widget";
  shadow.appendChild(root);
  const cleanupFns: Array<() => void> = [];
  let chatPopup: ChatPopupElement | null = null;
  let cleanReadOverlay: CleanReadOverlayElement | null = null;
  let popover: HTMLDivElement | null = null;
  let cleanedUp = false;

  const cleanupWidget = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (chatPopup) {
      chatPopup.cleanup?.();
      chatPopup.remove();
      chatPopup = null;
    }
    if (cleanReadOverlay) {
      cleanReadOverlay.cleanup?.();
      cleanReadOverlay.remove();
      cleanReadOverlay = null;
    }
    if (popover) {
      popover.remove();
      popover = null;
    }
    const bubbleTimer = widgetState?.bubbleHideTimer;
    if (bubbleTimer !== null && bubbleTimer !== undefined) {
      clearTimeout(bubbleTimer);
    }
    for (const fn of cleanupFns.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore cleanup failure */
      }
    }
    host.remove();
    if (cleanupCurrentWidget === cleanupWidget) cleanupCurrentWidget = null;
    widgetState = null;
  };
  cleanupCurrentWidget = cleanupWidget;
  const onTeardown = () => cleanupWidget();
  document.addEventListener(TEARDOWN_EVENT, onTeardown);
  cleanupFns.push(() => document.removeEventListener(TEARDOWN_EVENT, onTeardown));

  // 隐藏 X — 在 widget 左上, hover 显示, 点击隐藏整个 widget (刷新页面恢复).
  const closeWidgetBtn = document.createElement("button");
  closeWidgetBtn.className = "btn-close";
  closeWidgetBtn.title = "暂时隐藏 babata (刷新页面恢复)";
  closeWidgetBtn.appendChild(svg("M3 3l8 8 M11 3l-8 8", { size: 9, stroke: 1.6 }));
  closeWidgetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    cleanupWidget();
  });
  root.appendChild(closeWidgetBtn);

  // 按钮组
  const btnStack = document.createElement("div");
  btnStack.className = "stack";
  root.appendChild(btnStack);

  // 主头像锚点: bubble 绝对定位到头像左侧, 不参与按钮栈布局.
  const mainAnchor = document.createElement("div");
  mainAnchor.className = "main-anchor";
  btnStack.appendChild(mainAnchor);

  const bubbleSlot = document.createElement("div");
  bubbleSlot.className = "bubble-slot";
  mainAnchor.appendChild(bubbleSlot);

  // 初始化 state — 先用 default, async load 后 apply.
  widgetState = {
    shadow,
    root,
    mainAnchor,
    bubbleSlot,
    bubble: null,
    bubbleHideTimer: null,
    openChatPopup: null,
    mode: DEFAULT_MODE,
    selectionTranslationEnabled: DEFAULT_SELECTION_TRANSLATION_ENABLED,
    alwaysTranslateHosts: [],
    alwaysTranslateDisabledHosts: [],
    currentHost: normalizeHostname(location.hostname),
    pos: DEFAULT_POS,
  };
  applyPos(root, DEFAULT_POS);
  const onResize = () => refreshBubbleMetrics();
  window.addEventListener("resize", onResize);
  cleanupFns.push(() => window.removeEventListener("resize", onResize));

  const onRuntimeMessage = (
    msg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as { type?: string; action?: string; args?: Record<string, unknown> };
    if (m.type === "babata.notification" && m.action === "mascot_speak") {
      const text = (m.args?.text as string | undefined) ?? "";
      if (text) showBubble(text);
      sendResponse?.({ ok: true });
      return false;
    }
    if (
      m.type === "babata.notification" &&
      m.action === "clean_read_result"
    ) {
      const text = (m.args?.markdown as string | undefined) ?? "";
      renderCleanReadInPage(text || "净化阅读完成，但结果为空。", {
        title: (m.args?.title as string | undefined) ?? document.title,
        url: (m.args?.url as string | undefined) ?? location.href,
      });
      sendResponse?.({ ok: true });
      return false;
    }
    if (m.type === "babata.notification" && m.action === "clean_read_error") {
      const err = (m.args?.error as string | undefined) ?? "净化阅读失败";
      showBubble(`净读失败：${err}`, 12_000);
      sendResponse?.({ ok: true });
      return false;
    }
    if (m.type === "babata.translation_mode") {
      // SW 询问当前 mode (proactive 触发时塞 payload).
      const state = widgetState;
      sendResponse?.({
        mode: state
          ? effectiveTranslationModeForHost(
              state.mode,
              state.alwaysTranslateHosts,
              state.currentHost,
              state.alwaysTranslateDisabledHosts,
            )
          : DEFAULT_MODE,
      });
      return false;
    }
    return false;
  };
  safeChromeCall(() => chrome.runtime.onMessage.addListener(onRuntimeMessage));
  cleanupFns.push(() => {
    safeChromeCall(() => chrome.runtime.onMessage.removeListener(onRuntimeMessage));
  });

  function parseCleanReadMarkdown(markdown: string): CleanReadBlock[] {
    const blocks: CleanReadBlock[] = [];
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let paragraph: string[] = [];
    let list: string[] = [];
    let codeLines: string[] | null = null;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      const text = cleanReadInlineMarkdown(paragraph.join(" ").trim());
      if (text) blocks.push({ kind: "paragraph", text });
      paragraph = [];
    };
    const flushList = () => {
      if (list.length === 0) return;
      list.forEach((item) => {
        const text = cleanReadInlineMarkdown(item);
        if (text) blocks.push({ kind: "paragraph", text: `• ${text}` });
      });
      list = [];
    };
    const closeBlocks = () => {
      flushParagraph();
      flushList();
    };

    for (const line of lines) {
      if (/^```/.test(line.trim())) {
        if (codeLines) {
          const text = codeLines.join("\n").trim();
          closeBlocks();
          if (text) blocks.push({ kind: "code", text });
          codeLines = null;
        } else {
          closeBlocks();
          codeLines = [];
        }
        continue;
      }
      if (codeLines) {
        codeLines.push(line);
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        closeBlocks();
        continue;
      }
      if (/^[-*_]{3,}$/.test(trimmed)) {
        closeBlocks();
        continue;
      }
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        closeBlocks();
        const text = cleanReadInlineMarkdown(headingMatch[2].trim());
        if (text) blocks.push({ kind: "heading", text });
        continue;
      }
      const listMatch = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(trimmed);
      if (listMatch) {
        flushParagraph();
        list.push(listMatch[1].trim());
        continue;
      }
      if (trimmed.startsWith("> ")) {
        closeBlocks();
        const text = cleanReadInlineMarkdown(trimmed.slice(2).trim());
        if (text) blocks.push({ kind: "quote", text });
        continue;
      }
      flushList();
      paragraph.push(trimmed);
    }

    if (codeLines) {
      const text = codeLines.join("\n").trim();
      if (text) blocks.push({ kind: "code", text });
    }
    closeBlocks();
    return blocks.length > 0 ? blocks : [{ kind: "paragraph", text: markdown.trim() || "净化阅读完成。" }];
  }

  function cleanReadInlineMarkdown(text: string): string {
    return text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\\([\\`*_[\]()#+\-.!>])/g, "$1")
      .trim();
  }

  function ensureCleanReadPageStyle() {
    let s = document.getElementById(CLEAN_READ_STYLE_ID) as HTMLStyleElement | null;
    if (!s) {
      s = document.createElement("style");
      s.id = CLEAN_READ_STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    s.textContent = `
      .bbt-clean-read-hidden { display: none !important; }
      #${CLEAN_READ_ROOT_ID} { display: none !important; }
    `;
  }

  function cleanReadTextLen(el: Element): number {
    return (el.textContent || "").replace(/\s+/g, " ").trim().length;
  }

  function findCleanReadRoot(): HTMLElement {
    for (const selector of ["#js_content", ".rich_media_content", "article", "[itemprop='articleBody']"]) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement && cleanReadTextLen(el) >= 200) return el;
    }
    const selectors = [
      "#js_content",
      ".rich_media_content",
      "article",
      "main",
      "[role='main']",
      "[itemprop='articleBody']",
      "[class*='article' i]",
      "[id*='article' i]",
      "[class*='content' i]",
      "[id*='content' i]",
      "body",
    ];
    const candidates = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((el, i, arr): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        if (arr.indexOf(el) !== i) return false;
        if (el.id === HOST_ID || el.id === CLEAN_READ_ROOT_ID) return false;
        const textLen = cleanReadTextLen(el);
        return textLen >= 200 || el === document.body;
      });
    const scored = candidates.map((el) => {
      const textLen = cleanReadTextLen(el);
      const pCount = el.querySelectorAll("p").length;
      const headingCount = el.querySelectorAll("h1,h2,h3").length;
      const linkLen = Array.from(el.querySelectorAll("a")).reduce(
        (sum, a) => sum + cleanReadTextLen(a),
        0,
      );
      const linkPenalty = linkLen / Math.max(textLen, 1);
      const chromePenalty = el.querySelectorAll("nav,footer,aside,form,button,input").length;
      const bodyPenalty = el === document.body ? textLen * 0.8 : 0;
      return {
        el,
        score:
          textLen +
          pCount * 220 +
          headingCount * 80 -
          linkPenalty * textLen -
          chromePenalty * 120 -
          bodyPenalty,
      };
    });
    return (scored.sort((a, b) => b.score - a.score)[0]?.el || document.body) as HTMLElement;
  }

  function isCleanReadTextBlock(el: HTMLElement): boolean {
    if (el.id === HOST_ID || el.id === CLEAN_READ_ROOT_ID) return false;
    if (el.dataset.bbtCleanReadInserted === "1") return false;
    if (el.closest(`#${CLEAN_READ_ROOT_ID}`)) return false;
    if (["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "IFRAME", "SVG", "IMG", "VIDEO", "CANVAS"].includes(el.tagName)) {
      return false;
    }
    const textLen = cleanReadTextLen(el);
    if (textLen < 2) return false;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag) || ["p", "li", "blockquote", "pre"].includes(tag)) return true;
    if (["section", "div"].includes(tag)) {
      if (el.querySelector("img,video,canvas,iframe,svg")) return false;
      const childTextBlocks = Array.from(el.children).filter(
        (child) => child instanceof HTMLElement && cleanReadTextLen(child) > 0,
      );
      return childTextBlocks.length <= 1 && textLen < 600;
    }
    return false;
  }

  function collectCleanReadSlots(articleRoot: HTMLElement): HTMLElement[] {
    const direct = Array.from(articleRoot.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && isCleanReadTextBlock(child),
    );
    if (direct.length >= 3) return direct;
    return Array.from(
      articleRoot.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,section,div"),
    ).filter((el) => {
      if (!isCleanReadTextBlock(el)) return false;
      const parentBlock = el.parentElement?.closest("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,section,div");
      return !parentBlock || parentBlock === articleRoot;
    });
  }

  function cleanReadBlockText(blocks: CleanReadBlock[], index: number, maxSlots: number): string {
    if (index < maxSlots - 1 || blocks.length <= maxSlots) return blocks[index]?.text ?? "";
    return blocks
      .slice(index)
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n\n");
  }

  function rememberCleanReadSlot(
    snapshots: CleanReadSnapshot[],
    seen: WeakSet<HTMLElement>,
    el: HTMLElement,
  ) {
    if (seen.has(el)) return;
    seen.add(el);
    snapshots.push({ el, html: el.innerHTML, style: el.getAttribute("style") });
  }

  function restoreCleanReadSnapshot(snapshot: CleanReadSnapshot) {
    snapshot.el.innerHTML = snapshot.html;
    if (snapshot.style === null) snapshot.el.removeAttribute("style");
    else snapshot.el.setAttribute("style", snapshot.style);
    snapshot.el.classList.remove("bbt-clean-read-hidden");
    delete snapshot.el.dataset.bbtCleanReadHidden;
  }

  function restoreCleanRead() {
    cleanReadOverlay?.cleanup?.();
    document.getElementById(CLEAN_READ_ROOT_ID)?.remove();
    document.querySelectorAll<HTMLElement>("[data-bbt-clean-read-inserted='1']").forEach((el) => el.remove());
    cleanReadOverlay = null;
    document
      .querySelectorAll<HTMLElement>("[data-bbt-clean-read-hidden='1']")
      .forEach((el) => {
        el.classList.remove("bbt-clean-read-hidden");
        delete el.dataset.bbtCleanReadHidden;
      });
  }

  function renderCleanReadInPage(markdown: string, meta: { title: string; url: string }) {
    if (chatPopup) closeChatPopup();
    restoreCleanRead();
    ensureCleanReadPageStyle();

    const articleRoot = findCleanReadRoot();
    const slots = collectCleanReadSlots(articleRoot);
    const blocks = parseCleanReadMarkdown(markdown);
    const marker = document.createElement("div") as CleanReadOverlayElement;
    marker.id = CLEAN_READ_ROOT_ID;
    marker.title = meta.title || meta.url || "净化阅读";
    const firstSlot = slots[0] ?? articleRoot.firstChild;
    const snapshots: CleanReadSnapshot[] = [];
    const seen = new WeakSet<HTMLElement>();

    articleRoot.insertBefore(marker, firstSlot);
    if (slots.length === 0) {
      const fallback = document.createElement("p");
      fallback.dataset.bbtCleanReadInserted = "1";
      fallback.textContent = blocks.map((block) => block.text).join("\n\n");
      marker.after(fallback);
      rememberCleanReadSlot(snapshots, seen, fallback);
    } else {
      const writeCount = Math.min(blocks.length, slots.length);
      for (let i = 0; i < writeCount; i += 1) {
        const slot = slots[i];
        rememberCleanReadSlot(snapshots, seen, slot);
        slot.textContent = cleanReadBlockText(blocks, i, slots.length);
        slot.classList.remove("bbt-clean-read-hidden");
        delete slot.dataset.bbtCleanReadHidden;
      }
      slots.slice(writeCount).forEach((slot) => {
        rememberCleanReadSlot(snapshots, seen, slot);
        slot.dataset.bbtCleanReadHidden = "1";
        slot.classList.add("bbt-clean-read-hidden");
      });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      restoreCleanRead();
    };
    document.addEventListener("keydown", onKey);
    marker.cleanup = () => {
      document.removeEventListener("keydown", onKey);
      document.querySelectorAll<HTMLElement>("[data-bbt-clean-read-inserted='1']").forEach((el) => el.remove());
      snapshots.forEach(restoreCleanReadSnapshot);
    };
    cleanReadOverlay = marker;
    (slots[0] ?? articleRoot).scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // 主按钮 — 单击打开 page chat popup, 打开后触发模型建议 prompt; drag 移动.
  const mainBtn = document.createElement("button");
  mainBtn.className = "btn btn-main";
  mainBtn.title = "babata · 拖动改位置 · 单击对话 · 双击锐评 · 三击净化阅读";
  mainBtn.appendChild(avatar("avatar-main", "babata"));
  mainAnchor.appendChild(mainBtn);

  // 设置按钮
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "btn btn-secondary btn-collapsible";
  settingsBtn.title = "翻译设置";
  settingsBtn.appendChild(svg("M3 8h10 M3 4h10 M3 12h10", { size: 14, stroke: 1.4 }));
  btnStack.appendChild(settingsBtn);

  const openSidebar = () => {
    void safeChromePromise(() => chrome.runtime.sendMessage({ type: "babata.toggle_sidebar" }));
  };

  const requestPromptSuggestions = () => {
    void safeChromePromise(() => chrome.runtime.sendMessage({ type: "babata.suggest_prompts" }));
  };

  const requestAgentView = () => {
    showBubble(AGENT_VIEW_THINKING_TEXT, AGENT_VIEW_THINKING_DURATION_MS, {
      tone: "thinking",
      dismissible: false,
      interactive: false,
    });
    void safeChromePromise(() => chrome.runtime.sendMessage({ type: "babata.agent_view" }));
  };

  const closeChatPopup = () => {
    if (!chatPopup) return;
    chatPopup.cleanup?.();
    chatPopup.remove();
    chatPopup = null;
    root.classList.remove("chat-open");
  };

  const openChatPopup = (opts: OpenChatPopupOptions = {}) => {
    if (chatPopup) {
      if (opts.suggest) requestPromptSuggestions();
      return;
    }
    chatPopup = renderChatPopup(
      closeChatPopup,
      openSidebar,
      opts.suggest ? requestPromptSuggestions : undefined,
    );
    shadow.appendChild(chatPopup);
    // chat 打开时整个 widget 隐藏 — b 已"进入" chat header.
    root.classList.add("chat-open");
  };

  if (widgetState) widgetState.openChatPopup = openChatPopup;

  const requestCleanRead = () => {
    if (cleanReadOverlay) {
      restoreCleanRead();
      showBubble("已恢复原文", 2_500);
      return;
    }
    showBubble(CLEAN_READ_THINKING_TEXT, AGENT_VIEW_THINKING_DURATION_MS, {
      tone: "thinking",
      dismissible: false,
      interactive: false,
    });
    window.setTimeout(() => {
      void safeChromePromise(() => chrome.runtime.sendMessage({ type: "babata.clean_read" }));
    }, 180);
  };

  // ── interactions ─────────────────────────────────────────────────

  // drag — 跟踪 mousedown→mousemove→mouseup. 阈值 4px 区分 click vs drag.
  let dragOrigin: { x: number; y: number; startRight: number; startTop: number } | null = null;
  let dragged = false;
  let singleClickTimer: number | null = null;

  const clearSingleClickTimer = () => {
    if (singleClickTimer === null) return;
    window.clearTimeout(singleClickTimer);
    singleClickTimer = null;
  };
  cleanupFns.push(clearSingleClickTimer);

  mainBtn.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = root.getBoundingClientRect();
    dragOrigin = {
      x: e.clientX,
      y: e.clientY,
      startRight: window.innerWidth - rect.right,
      startTop: rect.top,
    };
    dragged = false;
    mainBtn.classList.add("dragging");
    e.preventDefault();
  });

  const onDragMove = (e: MouseEvent) => {
    if (!dragOrigin || !widgetState) return;
    const dx = e.clientX - dragOrigin.x;
    const dy = e.clientY - dragOrigin.y;
    if (!dragged && Math.hypot(dx, dy) > 4) dragged = true;
    if (!dragged) return;
    const right = Math.max(8, dragOrigin.startRight - dx);
    const top = Math.max(8, Math.min(window.innerHeight - 60, dragOrigin.startTop + dy));
    widgetState.pos = { right, top: top / window.innerHeight };
    applyPos(widgetState.root, widgetState.pos);
    refreshBubbleMetrics();
  };
  document.addEventListener("mousemove", onDragMove);
  cleanupFns.push(() => document.removeEventListener("mousemove", onDragMove));

  const onDragEnd = () => {
    if (!dragOrigin) return;
    mainBtn.classList.remove("dragging");
    if (dragged && widgetState) {
      const { pos } = widgetState;
      void safeChromePromise(() => chrome.storage.local.set({ [STORAGE_POS]: pos }));
    }
    dragOrigin = null;
  };
  document.addEventListener("mouseup", onDragEnd);
  cleanupFns.push(() => document.removeEventListener("mouseup", onDragEnd));

  mainBtn.addEventListener("click", (e) => {
    if (dragged) {
      // 是 drag 不触发 click
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const clickCount = Math.min(e.detail || 1, 3);
    clearSingleClickTimer();
    if (clickCount >= 3) {
      requestCleanRead();
      return;
    }
    singleClickTimer = window.setTimeout(() => {
      singleClickTimer = null;
      if (clickCount === 2) requestAgentView();
      else openChatPopup({ suggest: true });
    }, MAIN_SINGLE_CLICK_DELAY_MS);
  });

  // settings popover toggle
  const closePopover = () => {
    if (!popover) return;
    popover.remove();
    popover = null;
    root.classList.remove("expanded");
  };
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popover) {
      closePopover();
      return;
    }
    popover = renderPopover();
    btnStack.insertBefore(popover, settingsBtn);
    // popover 打开时强制保持展开 — 鼠标移开 widget 也别 collapse 否则 popover 漂浮无依托.
    root.classList.add("expanded");
  });

  const onDocumentClick = (e: MouseEvent) => {
    if (!popover) return;
    // closed shadow root 的 composedPath 不暴露内部 nodes — 之前 path.includes(popover)
    // 永远 false, 导致 V 点 popover 内 radio 时 popover 被误关 (radio 切换看似失败).
    // 改用 host 判断: 点击发生在我们的 host 内 (popover/settings/任意 widget 位置) 就不关.
    const path = e.composedPath();
    if (path.includes(host)) return;
    closePopover();
  };
  document.addEventListener("click", onDocumentClick);
  cleanupFns.push(() => document.removeEventListener("click", onDocumentClick));

  // ── async load ─────────────────────────────────────────────────────
  void (async () => {
    const {
      mode,
      selectionTranslationEnabled,
      alwaysTranslateHosts,
      alwaysTranslateDisabledHosts,
      currentHost,
      pos,
    } = await loadPersisted();
    if (!widgetState) return;
    widgetState.mode = mode;
    widgetState.selectionTranslationEnabled = selectionTranslationEnabled;
    widgetState.alwaysTranslateHosts = alwaysTranslateHosts;
    widgetState.alwaysTranslateDisabledHosts = alwaysTranslateDisabledHosts;
    widgetState.currentHost = currentHost;
    widgetState.pos = pos;
    applyPos(widgetState.root, pos);
    refreshBubbleMetrics();
  })();
}

function renderChatPopup(
  onClose: () => void,
  onOpenSidebar: () => void,
  onReady?: () => void,
): ChatPopupElement {
  const pop = document.createElement("div") as ChatPopupElement;
  pop.className = "chat-popup";
  const rightOffset = 70;
  const bottomOffset = 24;
  pop.style.right = `${rightOffset}px`;
  pop.style.bottom = `${bottomOffset}px`;

  const header = document.createElement("div");
  header.className = "chat-popup-header";

  // 左: babata avatar + label.
  const left = document.createElement("div");
  left.className = "header-left";

  left.appendChild(avatar("avatar-mini", "babata"));

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "babata";
  left.appendChild(label);

  header.appendChild(left);

  // 右: icon 工具行.
  const tools = document.createElement("div");
  tools.className = "header-tools";
  const openSide = document.createElement("button");
  openSide.className = "icon-btn";
  openSide.title = "打开侧边栏";
  openSide.appendChild(svg("M5 11l6-6 M7 5h4v4", { size: 13, stroke: 1.8 }));
  openSide.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpenSidebar();
    onClose();
  });
  tools.appendChild(openSide);

  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "关闭";
  close.appendChild(svg("M3 3l8 8 M11 3l-8 8", { size: 11, stroke: 1.6 }));
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    onClose();
  });
  tools.appendChild(close);
  header.appendChild(tools);

  pop.appendChild(header);

  const iframe = document.createElement("iframe");
  const sidepanelUrl = safeChromeCall(() => chrome.runtime.getURL("src/sidepanel.html"));
  const setIframeSrc = (ctx?: unknown) => {
    if (!sidepanelUrl) return;
    try {
      const url = new URL(sidepanelUrl);
      const c = (ctx && typeof ctx === "object") ? (ctx as Record<string, unknown>) : {};
      if (typeof c.tab_id === "number") url.searchParams.set("tab_id", String(c.tab_id));
      if (typeof c.window_id === "number") url.searchParams.set("window_id", String(c.window_id));
      iframe.src = url.toString();
    } catch {
      iframe.src = sidepanelUrl;
    }
  };
  if (sidepanelUrl) {
    void safeChromePromise(() =>
      chrome.runtime.sendMessage({ type: "babata.current_tab_context" }),
    ).then((ctx) => setIframeSrc(ctx));
    window.setTimeout(() => {
      if (!iframe.getAttribute("src")) setIframeSrc();
    }, 150);
  }
  iframe.title = "babata sidepanel";
  iframe.allow = "clipboard-read; clipboard-write";
  pop.appendChild(iframe);

  let readyTimer: number | null = null;
  let postLoadTimer: number | null = null;
  const clearReadyTimers = () => {
    if (readyTimer !== null) {
      window.clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (postLoadTimer !== null) {
      window.clearTimeout(postLoadTimer);
      postLoadTimer = null;
    }
  };
  const triggerReady = () => {
    clearReadyTimers();
    if (!pop.isConnected) return;
    onReady?.();
  };
  const onIframeLoad = () => {
    clearReadyTimers();
    postLoadTimer = window.setTimeout(triggerReady, 120);
  };
  if (onReady) {
    iframe.addEventListener("load", onIframeLoad, { once: true });
    readyTimer = window.setTimeout(triggerReady, 1200);
  }

  // popup 拖拽 — 抓 header 移动整个 popup.
  let drag: { x: number; y: number; right: number; bottom: number } | null = null;
  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      right: parseInt(pop.style.right, 10) || rightOffset,
      bottom: parseInt(pop.style.bottom, 10) || bottomOffset,
    };
    header.classList.add("grabbing");
    e.preventDefault();
  });
  const onPopupDragMove = (e: MouseEvent) => {
    if (!drag) return;
    const right = Math.max(8, drag.right - (e.clientX - drag.x));
    const bottom = Math.max(8, drag.bottom - (e.clientY - drag.y));
    pop.style.right = `${right}px`;
    pop.style.bottom = `${bottom}px`;
  };
  const onPopupDragEnd = () => {
    if (drag) header.classList.remove("grabbing");
    drag = null;
  };
  document.addEventListener("mousemove", onPopupDragMove);
  document.addEventListener("mouseup", onPopupDragEnd);
  pop.cleanup = () => {
    clearReadyTimers();
    iframe.removeEventListener("load", onIframeLoad);
    document.removeEventListener("mousemove", onPopupDragMove);
    document.removeEventListener("mouseup", onPopupDragEnd);
  };

  return pop;
}

function renderPopover(): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = "popover";
  const title = document.createElement("h4");
  title.textContent = "翻译设置";
  pop.appendChild(title);

  const opts: { value: TranslationRenderMode; label: string }[] = [
    { value: "bilingual", label: "双语" },
    { value: "replace", label: "替换" },
  ];

  for (const o of opts) {
    const lab = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "babata-mode";
    radio.value = o.value;
    radio.checked = widgetState?.mode === o.value;
    radio.addEventListener("change", () => {
      if (!widgetState) return;
      widgetState.mode = o.value;
      void safeChromePromise(() => chrome.storage.local.set({ [STORAGE_MODE]: o.value }));
    });
    lab.appendChild(radio);
    const labelBlock = document.createElement("div");
    const head = document.createElement("div");
    head.textContent = o.label;
    labelBlock.appendChild(head);
    lab.appendChild(labelBlock);
    pop.appendChild(lab);
  }

  const divider = document.createElement("div");
  divider.className = "divider";
  pop.appendChild(divider);

  const alwaysLabel = document.createElement("label");
  const alwaysCheckbox = document.createElement("input");
  const currentHost = widgetState?.currentHost ?? normalizeHostname(location.hostname);
  alwaysCheckbox.type = "checkbox";
  alwaysCheckbox.checked = isAlwaysTranslateHost(
    widgetState?.alwaysTranslateHosts ?? [],
    currentHost,
    widgetState?.alwaysTranslateDisabledHosts ?? [],
  );
  alwaysCheckbox.disabled = !currentHost;
  alwaysCheckbox.addEventListener("change", () => {
    if (!widgetState) return;
    const nextState = updateAlwaysTranslateHostState(
      widgetState.alwaysTranslateHosts,
      widgetState.alwaysTranslateDisabledHosts,
      widgetState.currentHost,
      alwaysCheckbox.checked,
    );
    widgetState.alwaysTranslateHosts = nextState.hosts;
    widgetState.alwaysTranslateDisabledHosts = nextState.disabledHosts;
    void safeChromePromise(() =>
      chrome.storage.local.set({
        [STORAGE_ALWAYS_TRANSLATE_HOSTS]: nextState.hosts,
        [STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS]: nextState.disabledHosts,
      })
    );
  });
  alwaysLabel.appendChild(alwaysCheckbox);
  const alwaysBlock = document.createElement("div");
  const alwaysHead = document.createElement("div");
  alwaysHead.textContent = "总是翻译此页";
  alwaysBlock.appendChild(alwaysHead);
  alwaysLabel.appendChild(alwaysBlock);
  pop.appendChild(alwaysLabel);

  const selectionLabel = document.createElement("label");
  const selectionCheckbox = document.createElement("input");
  selectionCheckbox.type = "checkbox";
  selectionCheckbox.checked = widgetState?.selectionTranslationEnabled ?? DEFAULT_SELECTION_TRANSLATION_ENABLED;
  selectionCheckbox.addEventListener("change", () => {
    if (!widgetState) return;
    widgetState.selectionTranslationEnabled = selectionCheckbox.checked;
    void safeChromePromise(() =>
      chrome.storage.local.set({ [STORAGE_SELECTION_TRANSLATION]: selectionCheckbox.checked })
    );
  });
  selectionLabel.appendChild(selectionCheckbox);
  const selectionBlock = document.createElement("div");
  const selectionHead = document.createElement("div");
  selectionHead.textContent = "划词翻译";
  selectionBlock.appendChild(selectionHead);
  selectionLabel.appendChild(selectionBlock);
  pop.appendChild(selectionLabel);
  return pop;
}

// ── bubble (server 推 mascot_speak 时浮起来) ────────────────────────

function showBubble(text: string, durationMs = 30_000, opts: BubbleOptions = {}) {
  if (!widgetState) return;
  // 同时只一个 bubble — 新的覆盖旧的.
  if (widgetState.bubble) {
    widgetState.bubble.remove();
    widgetState.bubble = null;
  }
  if (widgetState.bubbleHideTimer !== null) {
    clearTimeout(widgetState.bubbleHideTimer);
    widgetState.bubbleHideTimer = null;
  }

  const b = document.createElement("div");
  b.className = opts.tone === "thinking" ? "bubble bubble-thinking" : "bubble";
  b.textContent = text;

  if (opts.dismissible !== false) {
    const close = document.createElement("button");
    close.className = "bubble-close";
    close.textContent = "×";
    close.title = "关掉";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      if (widgetState?.bubble) {
        widgetState.bubble.remove();
        widgetState.bubble = null;
      }
    });
    b.appendChild(close);
  }

  // 点 bubble 本体 = 进入 page chat popup; sidebar 必须再点 popup 顶部按钮.
  if (opts.interactive !== false) {
    b.addEventListener("click", () => {
      widgetState?.openChatPopup?.();
    });
  }

  widgetState.bubbleSlot.appendChild(b);
  widgetState.bubble = b;
  refreshBubbleMetrics();
  widgetState.bubbleHideTimer = window.setTimeout(() => {
    if (widgetState?.bubble) {
      widgetState.bubble.remove();
      widgetState.bubble = null;
    }
  }, durationMs);
}

// ── boot ─────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", createWidget, { once: true });
} else {
  createWidget();
}

export {};
