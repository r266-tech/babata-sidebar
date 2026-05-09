import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./styles.css";

type Attachment = {
  id: string;
  kind: "image" | "video" | "file";
  name: string;
  mime: string;
  size: number;
  data_base64: string;
  preview_url?: string;
};

type Msg = {
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
};

type LightContext = {
  url: string;
  title: string;
  url_changed: boolean;
  tab_id?: number;
  window_id?: number;
};

type Suggestion = { id: string; text: string };

const SERVER = "http://127.0.0.1:18791";
const SIDEPANEL_PORT = "babata-sidepanel";

type ServerEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; name: string; input?: unknown }
  | { type: "tool_result"; is_error?: boolean; text?: string }
  | { type: "session"; session_id: string }
  | { type: "done" }
  | { type: "error"; text: string };

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text: string): string {
  if (!text) return "";
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
}

function MarkdownView(props: { text: string; placeholder?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (props.text) {
      Reflect.set(el, "innerHTML", renderMarkdown(props.text));
    } else if (props.placeholder) {
      el.textContent = props.placeholder;
    } else {
      el.textContent = "";
    }
  }, [props.text, props.placeholder]);
  return <div ref={ref} class="bbt-md" />;
}

function classifyAttachment(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("not data URL"));
      const idx = result.indexOf(",");
      resolve(idx === -1 ? "" : result.slice(idx + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function captureLightContext(lastUrl: string): Promise<LightContext | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return null;
    const url = tab.url ?? "";
    const title = tab.title ?? "";
    return {
      url,
      title,
      url_changed: !!url && url !== lastUrl,
      tab_id: tab.id,
      window_id: tab.windowId,
    };
  } catch {
    return null;
  }
}

async function captureCurrentSelection(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return "";
    const url = tab.url ?? "";
    if (
      !url ||
      url.startsWith("chrome://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("view-source:")
    ) {
      return "";
    }
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection()?.toString() ?? "").slice(0, 2000),
    });
    return ((exec?.result as string) ?? "").trim();
  } catch {
    return "";
  }
}

function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [pageMeta, setPageMeta] = useState<LightContext | null>(null);
  const [selection, setSelection] = useState<string>("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSentUrl = useRef<string>("");

  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    let pingTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;

    const clearPing = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const connectPort = () => {
      if (stopped) return;
      clearPing();
      try {
        port = chrome.runtime.connect({ name: SIDEPANEL_PORT });
      } catch {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectPort();
        }, 1500);
        return;
      }
      const ping = () => {
        try {
          port?.postMessage({ type: "babata.sidepanel_ping", ts: Date.now() });
        } catch {
          /* disconnected */
        }
      };
      port.onDisconnect.addListener(() => {
        port = null;
        clearPing();
        if (!stopped && reconnectTimer === null) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectPort();
          }, 1500);
        }
      });
      ping();
      pingTimer = window.setInterval(ping, 20_000);
    };

    connectPort();
    return () => {
      stopped = true;
      clearPing();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      try {
        port?.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER}/health`)
      .then((r) => {
        if (!cancelled) setServerOk(r.ok);
      })
      .catch(() => {
        if (!cancelled) setServerOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mount/refresh 时拉聊天历史 — V 关闭再开 sidebar / 刷新页面 / 切到 chat popup
  // iframe 都能恢复. 服务端 read_since_last_boundary, V 点新对话后只拉空.
  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER}/history?limit=200`)
      .then((r) => r.json())
      .then((data: { ok?: boolean; turns?: Array<{ role: string; text: string }> }) => {
        if (cancelled || !data.ok) return;
        const turns = data.turns ?? [];
        const restored: Msg[] = turns
          .filter((t) => t.role === "user" || t.role === "assistant")
          .map((t) => ({
            role: t.role as "user" | "assistant",
            text: t.text ?? "",
          }));
        if (restored.length > 0) setMsgs(restored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const [ctx, sel] = await Promise.all([
        captureLightContext(lastSentUrl.current),
        captureCurrentSelection(),
      ]);
      if (!alive) return;
      setPageMeta(ctx);
      setSelection(sel);
    };
    refresh();
    const onActivated = () => refresh();
    const onUpdated = (
      _tabId: number,
      info: chrome.tabs.TabChangeInfo,
    ) => {
      if (info.url || info.title || info.status === "complete") refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    const sleepy = window.setInterval(refresh, 1500);
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      window.clearInterval(sleepy);
    };
  }, []);

  useEffect(() => {
    const listener = (msg: unknown) => {
      const m = msg as
        | { type?: string; action?: string; args?: Record<string, unknown> }
        | undefined;
      if (m?.type !== "babata.notification") return;
      if (m.action === "suggest_prompts") {
        const arr = Array.isArray(m.args?.prompts) ? (m.args!.prompts as unknown[]) : [];
        const next: Suggestion[] = arr
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .slice(0, 6)
          .map((text, i) => ({ id: `${Date.now()}-${i}`, text: text.trim() }));
        setSuggestions(next);
      } else if (m.action === "clear_suggestions") {
        setSuggestions([]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  async function ingestFile(file: File) {
    if (file.size > 50 * 1024 * 1024) {
      alert(`文件太大 (>50MB): ${file.name}`);
      return;
    }
    try {
      const data_base64 = await readAsBase64(file);
      const kind = classifyAttachment(file);
      const att: Attachment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        name: file.name || "untitled",
        mime: file.type || "application/octet-stream",
        size: file.size,
        data_base64,
        preview_url:
          kind === "image" || kind === "video" ? URL.createObjectURL(file) : undefined,
      };
      setAttachments((prev) => [...prev, att]);
    } catch (e) {
      alert(`读取失败: ${(e as Error).message}`);
    }
  }

  async function ingestFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      // eslint-disable-next-line no-await-in-loop
      await ingestFile(f);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found?.preview_url) URL.revokeObjectURL(found.preview_url);
      return prev.filter((a) => a.id !== id);
    });
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      await ingestFiles(files);
    }
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) await ingestFiles(files);
  }

  function newSession() {
    setMsgs([]);
    setSuggestions([]);
    setInput("");
    // 让 server 起新 session: 发 /new 给 cc.py (复用 cc 的 /new 命令路径).
    void fetch(`${SERVER}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/new" }),
    }).catch(() => {});
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if ((!text && attachments.length === 0) || streaming) return;

    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);
    setSuggestions([]);
    setMsgs((m) => [
      ...m,
      { role: "user", text, attachments: sentAttachments },
      { role: "assistant", text: "" },
    ]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let accum = "";
    const appendAssistant = (chunk: string) => {
      accum += chunk;
      setMsgs((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant") return m;
        return [...m.slice(0, -1), { ...last, text: accum }];
      });
    };

    const ctx = await captureLightContext(lastSentUrl.current);
    if (ctx?.url) lastSentUrl.current = ctx.url;

    const wireAttachments = sentAttachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      size: a.size,
      data_base64: a.data_base64,
    }));

    try {
      const resp = await fetch(`${SERVER}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          page_context: ctx ?? undefined,
          attachments: wireAttachments.length > 0 ? wireAttachments : undefined,
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = raw
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          let ev: ServerEvent | null = null;
          try {
            ev = JSON.parse(data) as ServerEvent;
          } catch {
            continue;
          }
          if (ev.type === "text_delta" && typeof ev.text === "string") {
            appendAssistant(ev.text);
          } else if (ev.type === "error" && typeof ev.text === "string") {
            appendAssistant(`\n\n[err] ${ev.text}`);
          }
        }
      }
    } catch (e) {
      const m = e as { name?: string; message?: string };
      if (m?.name !== "AbortError") {
        appendAssistant(`\n\n[network] ${m?.message ?? String(e)}`);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function abort() {
    abortRef.current?.abort();
  }

  function copyMessage(text: string) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  const headerLine = (() => {
    if (!pageMeta) return "—";
    try {
      const host = new URL(pageMeta.url).host;
      return `${host}${pageMeta.title ? ` · ${pageMeta.title}` : ""}`;
    } catch {
      return pageMeta.title || pageMeta.url || "—";
    }
  })();

  return (
    <div
      class="flex flex-col h-screen bg-bbt text-bbt"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleDrop(e);
      }}
    >
      {/* 单 bar — Edge 自带 title bar 已显示 "babata" + 关闭, 我们只塞 status
          点 + 当前 tab + 新对话 + 菜单 一行紧凑搞定. */}
      <div class="px-3 pt-2 pb-1.5 flex items-center gap-2 text-[12px]">
        <span
          class="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background:
              serverOk === null ? "#ccc" : serverOk ? "#4ca36b" : "#c66a4a",
          }}
          title={
            serverOk === null
              ? "连接中"
              : serverOk
                ? "已连接 babata server"
                : "server 未运行 (127.0.0.1:18791)"
          }
        />
        <span
          class="text-bbt-muted truncate flex-1"
          title={pageMeta?.url ?? ""}
        >
          {headerLine}
        </span>
        <button
          class="btn-icon w-6 h-6 rounded-md flex items-center justify-center shrink-0"
          title="新对话"
          onClick={newSession}
        >
          <svg width="14" height="14" viewBox="0 0 15 15" fill="none">
            <path d="M7.5 3v9M3 7.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      {selection && (
        <div
          class="px-3 pb-1.5 text-bbt-subtle text-[11px] truncate italic"
          title={selection}
        >
          选中: “{selection.length > 80 ? selection.slice(0, 80) + "…" : selection}”
        </div>
      )}

      {/* Chat history */}
      <div ref={scrollRef} class="flex-1 overflow-y-auto px-4 py-2 space-y-5">
        {msgs.length === 0 && (
          <div class="text-bbt-muted text-[13px] leading-relaxed pt-8">
            <p class="mb-2">
              babata 浏览器侧边栏 · 跟 TG / 微信同一个 babata · 跨 channel 共享 chat-archive 长期记忆.
            </p>
            <p>
              她看到你当前 tab 的 url/title/url_changed, 自己决定要不要抓页面 / 翻译 / 推建议.
              ⌘+Enter 发送 · Alt+S 唤起 · 直接粘贴/拖图片/文件/视频进 sidebar.
            </p>
          </div>
        )}

        {msgs.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} class="flex flex-col items-end">
                {m.text && (
                  <div class="bg-bbt-user rounded-2xl px-3.5 py-2 max-w-[88%] whitespace-pre-wrap break-words">
                    {m.text}
                  </div>
                )}
                {m.attachments && m.attachments.length > 0 && (
                  <div class="flex flex-col gap-1.5 mt-1.5 items-end max-w-[88%]">
                    {m.attachments.map((a) => {
                      if (a.kind === "image" && a.preview_url) {
                        return (
                          <img
                            key={a.id}
                            src={a.preview_url}
                            alt={a.name}
                            class="max-w-[260px] max-h-[260px] rounded-xl border border-bbt object-contain"
                          />
                        );
                      }
                      if (a.kind === "video" && a.preview_url) {
                        return (
                          <video
                            key={a.id}
                            src={a.preview_url}
                            controls
                            class="max-w-[260px] rounded-xl border border-bbt bg-black"
                          />
                        );
                      }
                      return (
                        <span
                          key={a.id}
                          class="text-[12px] px-2.5 py-1 rounded-full bg-bbt-bubble border border-bbt"
                        >
                          📎 {a.name}{" "}
                          <span class="text-bbt-muted">
                            ({(a.size / 1024).toFixed(0)} KB)
                          </span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={i} class="flex flex-col items-start group">
              <MarkdownView
                text={m.text}
                placeholder={streaming && i === msgs.length - 1 ? "…" : ""}
              />
              {m.text && (!streaming || i !== msgs.length - 1) && (
                <div class="flex gap-1 mt-1.5 -ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    class="btn-icon w-6 h-6 rounded-md flex items-center justify-center"
                    title="复制"
                    onClick={() => copyMessage(m.text)}
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                      <rect x="3.5" y="3.5" width="7" height="8" rx="1.2" stroke="currentColor" stroke-width="1.2" />
                      <path d="M5.5 3.5V2.7c0-.4.3-.7.7-.7H10c.4 0 .7.3.7.7V8" stroke="currentColor" stroke-width="1.2" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Suggestion chips */}
      {suggestions.length > 0 && !streaming && (
        <div class="px-3 pb-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.id}
              class="text-[12px] px-2.5 py-1 rounded-full bg-bbt-bubble hover:bg-bbt-user border border-bbt transition"
              onClick={() => send(s.text)}
            >
              {s.text}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      <div class="px-3 pb-3">
        {attachments.length > 0 && (
          <div class="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                class="relative bg-bbt-input border border-bbt rounded-xl text-[12px] flex items-center gap-1.5 pr-6 pl-1.5 py-1"
              >
                {a.kind === "image" && a.preview_url ? (
                  <img src={a.preview_url} alt="" class="w-7 h-7 object-cover rounded-md" />
                ) : (
                  <span class="text-base leading-none w-7 h-7 flex items-center justify-center">
                    {a.kind === "video" ? "🎬" : "📎"}
                  </span>
                )}
                <span class="max-w-[140px] truncate" title={a.name}>
                  {a.name}
                </span>
                <button
                  class="absolute top-0.5 right-1 text-bbt-muted hover:text-bbt leading-none w-4 h-4 flex items-center justify-center text-base"
                  onClick={() => removeAttachment(a.id)}
                  title="移除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div class="bg-bbt-input border border-bbt rounded-2xl flex flex-col">
          <textarea
            class="resize-none bg-transparent outline-none px-3.5 pt-3 pb-1 text-[14px] placeholder:text-bbt-subtle"
            rows={2}
            placeholder="跟 babata 说点什么… (Enter 发送 · Shift+Enter 换行)"
            value={input}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onPaste={(e) => handlePaste(e as unknown as ClipboardEvent)}
            onKeyDown={(e) => {
              // Enter 发送, Shift+Enter 换行 (跟 ChatGPT/Claude.ai 同肌肉记忆).
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div class="flex items-center gap-1 px-2 pb-2">
            <span class="flex-1" />
            <button
              class="btn-icon w-7 h-7 rounded-md flex items-center justify-center"
              title="附加文件"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              class="hidden"
              onChange={(e) => {
                const t = e.target as HTMLInputElement;
                if (t.files) ingestFiles(t.files);
                t.value = "";
              }}
            />
            <button
              class={`w-7 h-7 rounded-md flex items-center justify-center transition ${
                streaming || input.trim() || attachments.length > 0
                  ? "bg-bbt-accent"
                  : "bg-bbt-bubble text-bbt-subtle"
              }`}
              onClick={streaming ? abort : () => send()}
              disabled={!streaming && !input.trim() && attachments.length === 0}
              title={streaming ? "停止" : "发送"}
            >
              {streaming ? (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <rect x="2" y="2" width="7" height="7" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path
                    d="M6.5 11V2M3 5.5L6.5 2L10 5.5"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
