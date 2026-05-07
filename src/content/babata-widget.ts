/// <reference types="chrome" />

// babata 桌宠 floating widget — 可拖拽圆形按钮 + 设置弹窗 + 主动 bubble.
//
// 哲学: 内容物 LLM 决定 (bubble 文本 / 翻译要不要做), widget 只是容器.
// Shadow DOM 物理隔离站点 CSS, all:initial 防 site reset 干扰.
//
// V0 元素:
//   主按钮 (drag-able, 点击 = toggle sidebar)
//   设置按钮 (翻译三档位)
//   bubble (server 推 mascot_speak 时浮起来, 30s auto-dismiss, V 点 X 关掉)

type TranslationMode = "off" | "auto" | "bilingual";

const HOST_ID = "__babata_widget_host__";
const STORAGE_POS = "babata.widget.pos";
const STORAGE_MODE = "babata.translation_mode";
const DEFAULT_MODE: TranslationMode = "bilingual";

interface WidgetPos {
  right: number;
  top: number;
}

const DEFAULT_POS: WidgetPos = { right: 18, top: 0.5 }; // top 比例 (0-1)

let widgetState: {
  shadow: ShadowRoot;
  root: HTMLDivElement;
  bubble: HTMLDivElement | null;
  bubbleHideTimer: number | null;
  mode: TranslationMode;
  pos: WidgetPos;
} | null = null;

function applyPos(root: HTMLElement, pos: WidgetPos) {
  root.style.right = `${pos.right}px`;
  root.style.top = `${pos.top * window.innerHeight}px`;
}

async function loadPersisted(): Promise<{ mode: TranslationMode; pos: WidgetPos }> {
  try {
    const got = await chrome.storage.local.get([STORAGE_MODE, STORAGE_POS]);
    return {
      mode: (got[STORAGE_MODE] as TranslationMode) || DEFAULT_MODE,
      pos: (got[STORAGE_POS] as WidgetPos) || DEFAULT_POS,
    };
  } catch {
    return { mode: DEFAULT_MODE, pos: DEFAULT_POS };
  }
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

function createWidget() {
  if (document.getElementById(HOST_ID)) return;
  if (!document.documentElement) return;

  // 当前 frame 是顶 frame 才注入 (避免 iframe 内重复 widget).
  if (window.top !== window.self) return;

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
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      color: #1c1c1c;
      pointer-events: auto;
      user-select: none;
    }
    .btn {
      width: 38px; height: 38px; border-radius: 999px;
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
    .btn-secondary { width: 32px; height: 32px; }

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

    .bubble {
      max-width: 240px;
      background: #1c1c1c;
      color: #f5f1eb;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
      position: relative;
      cursor: pointer;
    }
    .bubble::after {
      content: "";
      position: absolute;
      right: -6px; top: 14px;
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
    .popover h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1c1c1c; }
    .popover p { margin: 0 0 10px; font-size: 11.5px; color: #6e6b66; }
    .popover label {
      display: flex; align-items: flex-start; gap: 8px;
      font-size: 13px; padding: 6px 0; cursor: pointer;
    }
    .popover label .desc { font-size: 11px; color: #6e6b66; display: block; margin-top: 2px; }
    .popover input[type=radio] { margin: 4px 0 0 0; accent-color: #c66a4a; }

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
    .chat-popup-header .header-left .logo { color: #c66a4a; flex-shrink: 0; }
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
  `;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "widget";
  shadow.appendChild(root);

  // 隐藏 X — 在 widget 左上, hover 显示, 点击隐藏整个 widget (刷新页面恢复).
  const closeWidgetBtn = document.createElement("button");
  closeWidgetBtn.className = "btn-close";
  closeWidgetBtn.title = "暂时隐藏 babata (刷新页面恢复)";
  closeWidgetBtn.appendChild(svg("M3 3l8 8 M11 3l-8 8", { size: 9, stroke: 1.6 }));
  closeWidgetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    host.remove();
    widgetState = null;
  });
  root.appendChild(closeWidgetBtn);

  // 初始化 state — 先用 default, async load 后 apply.
  widgetState = {
    shadow,
    root,
    bubble: null,
    bubbleHideTimer: null,
    mode: DEFAULT_MODE,
    pos: DEFAULT_POS,
  };
  applyPos(root, DEFAULT_POS);

  // bubble 容器 (上方)
  const bubbleSlot = document.createElement("div");
  bubbleSlot.className = "stack";
  root.appendChild(bubbleSlot);

  // 按钮组 (下方)
  const btnStack = document.createElement("div");
  btnStack.className = "stack";
  root.appendChild(btnStack);

  // 主按钮 — 点击 toggle sidebar, drag 移动.
  const mainBtn = document.createElement("button");
  mainBtn.className = "btn";
  mainBtn.title = "babata · 拖动改位置 · 点击开关侧边栏";
  // 简笔 babata "B" 圆形 logo.
  const logo = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  logo.setAttribute("width", "20");
  logo.setAttribute("height", "20");
  logo.setAttribute("viewBox", "0 0 20 20");
  logo.setAttribute("fill", "none");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "10"); c.setAttribute("cy", "10"); c.setAttribute("r", "8");
  c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "1.6");
  logo.appendChild(c);
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", "10"); text.setAttribute("y", "13.5");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", "10");
  text.setAttribute("font-weight", "600");
  text.setAttribute("fill", "currentColor");
  text.textContent = "b";
  logo.appendChild(text);
  mainBtn.appendChild(logo);
  btnStack.appendChild(mainBtn);

  // chat popup 按钮 — 像 Grok 那样, 在 page 上弹小聊天框 (iframe 嵌 sidepanel.html).
  const chatBtn = document.createElement("button");
  chatBtn.className = "btn btn-collapsible";
  chatBtn.title = "弹出聊天 (iframe 嵌 sidepanel)";
  // chat bubble icon
  const chatSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chatSvg.setAttribute("width", "18");
  chatSvg.setAttribute("height", "18");
  chatSvg.setAttribute("viewBox", "0 0 18 18");
  chatSvg.setAttribute("fill", "none");
  const chatPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  chatPath.setAttribute(
    "d",
    "M3 7.5C3 5.6 4.6 4 6.5 4h5C13.4 4 15 5.6 15 7.5v2c0 1.9-1.6 3.5-3.5 3.5H8l-3 2.5V13H6.5C4.6 13 3 11.4 3 9.5z",
  );
  chatPath.setAttribute("stroke", "currentColor");
  chatPath.setAttribute("stroke-width", "1.5");
  chatPath.setAttribute("stroke-linejoin", "round");
  chatSvg.appendChild(chatPath);
  chatBtn.appendChild(chatSvg);
  btnStack.appendChild(chatBtn);

  // 设置按钮
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "btn btn-secondary btn-collapsible";
  settingsBtn.title = "翻译设置";
  settingsBtn.appendChild(svg("M3 8h10 M3 4h10 M3 12h10", { size: 14, stroke: 1.4 }));
  btnStack.appendChild(settingsBtn);

  // chat popup state — 同时只一个 popup, toggle 开关.
  let chatPopup: HTMLDivElement | null = null;
  chatBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (chatPopup) {
      chatPopup.remove();
      chatPopup = null;
      root.classList.remove("chat-open");
      return;
    }
    chatPopup = renderChatPopup(() => {
      if (chatPopup) {
        chatPopup.remove();
        chatPopup = null;
      }
      root.classList.remove("chat-open");
    });
    shadow.appendChild(chatPopup);
    // chat 打开时整个 widget 隐藏 — b 已"进入" chat header.
    root.classList.add("chat-open");
  });

  // ── interactions ─────────────────────────────────────────────────

  // drag — 跟踪 mousedown→mousemove→mouseup. 阈值 4px 区分 click vs drag.
  let dragOrigin: { x: number; y: number; startRight: number; startTop: number } | null = null;
  let dragged = false;

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

  document.addEventListener("mousemove", (e) => {
    if (!dragOrigin || !widgetState) return;
    const dx = e.clientX - dragOrigin.x;
    const dy = e.clientY - dragOrigin.y;
    if (!dragged && Math.hypot(dx, dy) > 4) dragged = true;
    if (!dragged) return;
    const right = Math.max(8, dragOrigin.startRight - dx);
    const top = Math.max(8, Math.min(window.innerHeight - 60, dragOrigin.startTop + dy));
    widgetState.pos = { right, top: top / window.innerHeight };
    applyPos(widgetState.root, widgetState.pos);
  });

  document.addEventListener("mouseup", () => {
    if (!dragOrigin) return;
    mainBtn.classList.remove("dragging");
    if (dragged && widgetState) {
      void chrome.storage.local.set({ [STORAGE_POS]: widgetState.pos });
    }
    dragOrigin = null;
  });

  mainBtn.addEventListener("click", (e) => {
    if (dragged) {
      // 是 drag 不触发 click
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    void chrome.runtime.sendMessage({ type: "babata.toggle_sidebar" });
  });

  // settings popover toggle
  let popover: HTMLDivElement | null = null;
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

  document.addEventListener("click", (e) => {
    if (!popover) return;
    // closed shadow root 的 composedPath 不暴露内部 nodes — 之前 path.includes(popover)
    // 永远 false, 导致 V 点 popover 内 radio 时 popover 被误关 (radio 切换看似失败).
    // 改用 host 判断: 点击发生在我们的 host 内 (popover/settings/任意 widget 位置) 就不关.
    const path = e.composedPath();
    if (path.includes(host)) return;
    closePopover();
  });

  // ── async load ─────────────────────────────────────────────────────
  void (async () => {
    const { mode, pos } = await loadPersisted();
    if (!widgetState) return;
    widgetState.mode = mode;
    widgetState.pos = pos;
    applyPos(widgetState.root, pos);
  })();
}

function renderChatPopup(onClose: () => void): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = "chat-popup";
  const rightOffset = 70;
  const bottomOffset = 24;
  pop.style.right = `${rightOffset}px`;
  pop.style.bottom = `${bottomOffset}px`;

  const header = document.createElement("div");
  header.className = "chat-popup-header";

  // 左: babata b logo + label.
  const left = document.createElement("div");
  left.className = "header-left";

  const NS = "http://www.w3.org/2000/svg";
  const logo = document.createElementNS(NS, "svg");
  logo.setAttribute("class", "logo");
  logo.setAttribute("width", "16");
  logo.setAttribute("height", "16");
  logo.setAttribute("viewBox", "0 0 20 20");
  logo.setAttribute("fill", "none");
  const c = document.createElementNS(NS, "circle");
  c.setAttribute("cx", "10"); c.setAttribute("cy", "10"); c.setAttribute("r", "8");
  c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "1.6");
  logo.appendChild(c);
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", "10"); t.setAttribute("y", "13.5");
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("font-size", "10");
  t.setAttribute("font-weight", "600");
  t.setAttribute("fill", "currentColor");
  t.textContent = "b";
  logo.appendChild(t);
  left.appendChild(logo);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "babata";
  left.appendChild(label);

  header.appendChild(left);

  // 右: icon 工具行 (V0 只放 close, 后续按需加新对话/历史/展开 sidebar).
  const tools = document.createElement("div");
  tools.className = "header-tools";
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
  iframe.src = chrome.runtime.getURL("src/sidepanel.html");
  iframe.title = "babata sidepanel";
  iframe.allow = "clipboard-read; clipboard-write";
  pop.appendChild(iframe);

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
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const right = Math.max(8, drag.right - (e.clientX - drag.x));
    const bottom = Math.max(8, drag.bottom - (e.clientY - drag.y));
    pop.style.right = `${right}px`;
    pop.style.bottom = `${bottom}px`;
  });
  document.addEventListener("mouseup", () => {
    if (drag) header.classList.remove("grabbing");
    drag = null;
  });

  return pop;
}

function renderPopover(): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = "popover";
  const title = document.createElement("h4");
  title.textContent = "翻译模式";
  pop.appendChild(title);
  const desc = document.createElement("p");
  desc.textContent = "babata 进入新页面时自动判断要不要翻译.";
  pop.appendChild(desc);

  const opts: { value: TranslationMode; label: string; desc: string }[] = [
    { value: "off", label: "不翻译", desc: "你主动让 babata 翻才翻" },
    { value: "auto", label: "自动翻译 (替换)", desc: "外语页 → 译文替换原文" },
    { value: "bilingual", label: "双语 (默认)", desc: "原文 + 译文同时显示, 沉浸式" },
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
      void chrome.storage.local.set({ [STORAGE_MODE]: o.value });
    });
    lab.appendChild(radio);
    const labelBlock = document.createElement("div");
    const head = document.createElement("div");
    head.textContent = o.label;
    labelBlock.appendChild(head);
    const sub = document.createElement("span");
    sub.className = "desc";
    sub.textContent = o.desc;
    labelBlock.appendChild(sub);
    lab.appendChild(labelBlock);
    pop.appendChild(lab);
  }
  return pop;
}

// ── bubble (server 推 mascot_speak 时浮起来) ────────────────────────

function showBubble(text: string, durationMs = 30_000) {
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
  b.className = "bubble";
  b.textContent = text;

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

  // 点 bubble 本体 = 打开 sidebar.
  b.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "babata.toggle_sidebar" });
  });

  const slot = widgetState.root.firstElementChild as HTMLElement | null;
  if (slot) slot.appendChild(b);
  widgetState.bubble = b;
  widgetState.bubbleHideTimer = window.setTimeout(() => {
    if (widgetState?.bubble) {
      widgetState.bubble.remove();
      widgetState.bubble = null;
    }
  }, durationMs);
}

// ── messages from SW ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string; action?: string; args?: Record<string, unknown> };
  if (m.type === "babata.notification" && m.action === "mascot_speak") {
    const text = (m.args?.text as string | undefined) ?? "";
    if (text) showBubble(text);
    sendResponse?.({ ok: true });
    return false;
  }
  if (m.type === "babata.translation_mode") {
    // SW 询问当前 mode (proactive 触发时塞 payload).
    sendResponse?.({ mode: widgetState?.mode ?? DEFAULT_MODE });
    return false;
  }
  return false;
});

// ── boot ─────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", createWidget, { once: true });
} else {
  createWidget();
}

export {};
