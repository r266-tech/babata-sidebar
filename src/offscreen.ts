/// <reference types="chrome" />

// Offscreen document — 持久 ws 通道 (MV3 SW idle 30s kill 不杀这).
//
// 哲学: SW 是 dispatcher (chrome.scripting.executeScript 等只能 SW 跑),
// offscreen 是长连透 (ws). 双向消息走 chrome.runtime.sendMessage 流转:
//   server WS  ──→ offscreen ──→ SW (handle, 跑 chrome.scripting) ──→ offscreen ──→ server WS
//   server WS notification ──→ offscreen ──→ SW ──→ sidepanel (通知 chip 等)
//
// 抄 Anthropic Claude in Chrome 1.0.70 同手法 (research/01 finding 3).

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 18791;
const WS_URL = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const SW_KEEPALIVE_MS = 20_000;

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: number | null = null;

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(1.7, reconnectAttempt),
    RECONNECT_MAX_MS,
  );
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    console.log("[babata-offscreen] ws connected");
  });
  ws.addEventListener("close", () => {
    console.log("[babata-offscreen] ws closed");
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    /* close handler 触发 reconnect */
  });
  ws.addEventListener("message", (ev) => {
    // forward 到 SW. SW 处理完通过 chrome.runtime.sendMessage 回我.
    chrome.runtime
      .sendMessage({
        type: "babata.ws.inbound",
        payload: typeof ev.data === "string" ? ev.data : "",
      })
      .catch(() => {
        /* SW 可能在 cold-start, 一次失败 OK — server WS 会 timeout 处理 */
      });
  });
}

// SW 想发消息出去, 通过 chrome.runtime.sendMessage with type babata.ws.outbound
// 转给我 — 我 ws.send. SW 没 ws 引用, 必须经我.
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string; payload?: string };
  if (m.type === "babata.ws.outbound" && typeof m.payload === "string") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(m.payload);
      } catch (e) {
        console.warn("[babata-offscreen] ws.send failed", e);
      }
    } else {
      console.warn("[babata-offscreen] outbound dropped: ws not open");
    }
  }
});

// SW keepalive — 20s 一次 ping, 让 SW 的 idle timer 重置. SW 收到这个 message
// 就被算 "活动", 不会被 30s idle kill. (Anthropic 1.0.70 offscreen.js 同手法.)
window.setInterval(() => {
  chrome.runtime.sendMessage({ type: "babata.keepalive" }).catch(() => {});
}, SW_KEEPALIVE_MS);

connect();

export {};
