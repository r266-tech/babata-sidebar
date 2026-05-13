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

type ToolTraceStatus = "running" | "done" | "error";

type ToolTrace = {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  status: ToolTraceStatus;
  is_error?: boolean;
  started_at?: number;
  ended_at?: number;
  duration_ms?: number;
};

type MessagePart =
  | { type: "text"; id: string; text: string }
  | {
      type: "page_read";
      id: string;
      name: string;
      status: ToolTraceStatus;
      is_error?: boolean;
      duration_ms?: number;
    };

type Msg = {
  role: "user" | "assistant";
  text: string;
  parts?: MessagePart[];
  attachments?: Attachment[];
  tools?: ToolTrace[];
  clean_read_id?: string;
  pending?: boolean;
};

type LightContext = {
  url: string;
  title: string;
  url_changed: boolean;
  tab_id?: number;
  window_id?: number;
  selection?: string;
};

type Suggestion = { id: string; text: string };
type PinnedTarget = { tab_id?: number; window_id?: number };

const SERVER = "http://127.0.0.1:18791";
const SIDEPANEL_PORT = "babata-sidepanel";

type ServerEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; trace_id?: string; name: string; input?: unknown }
  | { type: "tool_result"; trace_id?: string; is_error?: boolean; text?: string }
  | { type: "session"; session_id: string }
  | { type: "done" }
  | { type: "error"; text: string };

marked.setOptions({ breaks: true, gfm: true });

const PAGE_READ_TOOLS = new Set(["tab_metadata", "page_snapshot", "dom_query", "article_extract"]);

function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function textField(value: unknown, key: string): string {
  const found = objectField(value, key);
  return typeof found === "string" ? found : "";
}

function effectiveToolName(name: string, input?: unknown): string {
  const rawTool = textField(input, "tool");
  const rawServer = textField(input, "server");
  if (rawTool) return rawServer ? `${rawServer}.${rawTool}` : rawTool;
  return name;
}

function isPageReadTool(name: string, input?: unknown): boolean {
  const effective = effectiveToolName(name, input);
  if (PAGE_READ_TOOLS.has(effective)) return true;
  for (const tool of PAGE_READ_TOOLS) {
    if (effective.endsWith(`.${tool}`) || effective.endsWith(`/${tool}`)) return true;
  }
  return false;
}

function newPartId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

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

function toolStatus(t: ToolTrace): ToolTraceStatus {
  if (t.status === "error" || t.is_error) return "error";
  if (t.status === "done") return "done";
  return "running";
}

function pinnedTargetFromLocation(): PinnedTarget | null {
  const params = new URLSearchParams(window.location.search);
  const tab = Number(params.get("tab_id") ?? "");
  const win = Number(params.get("window_id") ?? "");
  const target: PinnedTarget = {};
  if (Number.isInteger(tab) && tab > 0) target.tab_id = tab;
  if (Number.isInteger(win) && win >= 0) target.window_id = win;
  return target.tab_id !== undefined || target.window_id !== undefined ? target : null;
}

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

async function activePageContextFromSw(): Promise<PinnedTarget | null> {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "babata.active_page_context" }) as
      | { ok?: boolean; tab_id?: number; window_id?: number }
      | undefined;
    if (!resp?.ok || typeof resp.tab_id !== "number") return null;
    return {
      tab_id: resp.tab_id,
      window_id: typeof resp.window_id === "number" ? resp.window_id : undefined,
    };
  } catch {
    return null;
  }
}

async function tabForTarget(target?: PinnedTarget | null): Promise<chrome.tabs.Tab | null> {
  if (target?.tab_id !== undefined) {
    return await chrome.tabs.get(target.tab_id);
  }
  const queries: chrome.tabs.QueryInfo[] = target?.window_id !== undefined
    ? [{ active: true, windowId: target.window_id }]
    : [
        { active: true, lastFocusedWindow: true },
        { active: true, currentWindow: true },
        { active: true },
      ];
  for (const query of queries) {
    try {
      const tabs = await chrome.tabs.query(query);
      const tab = tabs.find((candidate) => candidate.id !== undefined && isPageUrl(candidate.url));
      if (tab) return tab;
    } catch {
      /* try next query */
    }
  }
  const remembered = await activePageContextFromSw();
  if (remembered?.tab_id !== undefined) {
    return await chrome.tabs.get(remembered.tab_id);
  }
  return null;
}

function normalizeToolTrace(raw: unknown): ToolTrace[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item, i) => ({
      id: typeof item.id === "string" ? item.id : `history-tool-${i + 1}`,
      name: typeof item.name === "string" ? item.name : "tool",
      input: item.input,
      result: typeof item.result === "string" ? item.result : undefined,
      status:
        item.status === "done" || item.status === "error" || item.status === "running"
          ? item.status
          : item.is_error
            ? "error"
            : "done",
      is_error: item.is_error === true,
      started_at: typeof item.started_at === "number" ? item.started_at : undefined,
      ended_at: typeof item.ended_at === "number" ? item.ended_at : undefined,
      duration_ms: typeof item.duration_ms === "number" ? item.duration_ms : undefined,
    }));
}

function pageReadText(status: ToolTraceStatus): string {
  if (status === "running") return "正在读取当前网页";
  if (status === "error") return "读取网页失败";
  return "已读取当前网页";
}

function PageReadInline(props: {
  status: ToolTraceStatus;
  duration_ms?: number;
}) {
  return (
    <div class={`bbt-page-read bbt-page-read-${props.status}`}>
      <span class="bbt-page-read-dot" aria-hidden="true" />
      <span>{pageReadText(props.status)}</span>
      {props.duration_ms !== undefined && props.status !== "running" && (
        <span class="bbt-page-read-time">{props.duration_ms}ms</span>
      )}
    </div>
  );
}

function AssistantParts(props: { parts: MessagePart[]; placeholder?: string }) {
  if (props.parts.length === 0) {
    return <MarkdownView text="" placeholder={props.placeholder} />;
  }
  return (
    <div class="bbt-assistant-flow">
      {props.parts.map((part) => {
        if (part.type === "text") {
          return <MarkdownView key={part.id} text={part.text} />;
        }
        return (
          <PageReadInline
            key={part.id}
            status={part.status}
            duration_ms={part.duration_ms}
          />
        );
      })}
    </div>
  );
}

function PageReadTraceList(props: { tools?: ToolTrace[] }) {
  const tools = (props.tools ?? []).filter((tool) => isPageReadTool(tool.name, tool.input));
  if (tools.length === 0) return null;
  return (
    <div class="bbt-inline-tools">
      {tools.map((tool) => (
        <PageReadInline
          key={tool.id}
          status={toolStatus(tool)}
          duration_ms={tool.duration_ms}
        />
      ))}
    </div>
  );
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

async function captureLightContext(
  lastUrl: string,
  target?: PinnedTarget | null,
): Promise<LightContext | null> {
  try {
    const tab = await tabForTarget(target);
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

async function captureCurrentSelection(target?: PinnedTarget | null): Promise<string> {
  try {
    const tab = await tabForTarget(target);
    if (!tab?.id) return "";
    const url = tab.url ?? "";
    if (!isPageUrl(url)) {
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
  const pinnedTarget = useRef<PinnedTarget | null>(pinnedTargetFromLocation());

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
      .then((data: {
        ok?: boolean;
        turns?: Array<{ role: string; text: string; tool_trace?: unknown }>;
      }) => {
        if (cancelled || !data.ok) return;
        const turns = data.turns ?? [];
        const restored: Msg[] = turns
          .filter((t) => t.role === "user" || t.role === "assistant")
          .map((t) => ({
            role: t.role as "user" | "assistant",
            text: t.text ?? "",
            tools: normalizeToolTrace(t.tool_trace),
          }));
        if (restored.length > 0) setMsgs((prev) => (prev.length === 0 ? restored : prev));
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
        captureLightContext(lastSentUrl.current, pinnedTarget.current),
        captureCurrentSelection(pinnedTarget.current),
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
      const argText = (key: string) =>
        typeof m.args?.[key] === "string" ? (m.args[key] as string) : "";
      if (m.action === "suggest_prompts") {
        const arr = Array.isArray(m.args?.prompts) ? (m.args!.prompts as unknown[]) : [];
        const next: Suggestion[] = arr
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .slice(0, 2)
          .map((text, i) => ({ id: `${Date.now()}-${i}`, text: text.trim() }));
        setSuggestions(next);
      } else if (m.action === "clear_suggestions") {
        setSuggestions([]);
      } else if (m.action === "clean_read_started") {
        const runId = argText("run_id") || `${Date.now()}`;
        const title = argText("title");
        const url = argText("url");
        const label = title || url || "当前文章";
        setSuggestions([]);
        setMsgs((prev) => [
          ...prev,
          { role: "user", text: `净化阅读：${label}`, clean_read_id: runId },
          {
            role: "assistant",
            text: "正在抽取文章，保留好梗，剥掉传播噪声…",
            clean_read_id: runId,
            pending: true,
          },
        ]);
      } else if (m.action === "clean_read_result") {
        const runId = argText("run_id");
        const markdown = argText("markdown") || "净化阅读完成，但结果为空。";
        setMsgs((prev) => {
          let updated = false;
          const next = prev.map((item) => {
            if (item.role === "assistant" && item.clean_read_id === runId) {
              updated = true;
              return { ...item, text: markdown, pending: false };
            }
            return item;
          });
          return updated ? next : [...next, { role: "assistant", text: markdown }];
        });
      } else if (m.action === "clean_read_error") {
        const runId = argText("run_id");
        const error = argText("error") || "净化阅读失败";
        const text = `[净化阅读失败] ${error}`;
        setMsgs((prev) => {
          let updated = false;
          const next = prev.map((item) => {
            if (item.role === "assistant" && item.clean_read_id === runId) {
              updated = true;
              return { ...item, text, pending: false };
            }
            return item;
          });
          return updated ? next : [...next, { role: "assistant", text }];
        });
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
    abortRef.current?.abort();
    setMsgs([]);
    setSuggestions([]);
    setInput("");
    setStreaming(false);
    setAttachments((prev) => {
      prev.forEach((a) => {
        if (a.preview_url) URL.revokeObjectURL(a.preview_url);
      });
      return [];
    });
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
    const updateLastAssistant = (fn: (msg: Msg) => Msg) => {
      setMsgs((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant") return m;
        return [...m.slice(0, -1), fn(last)];
      });
    };
    const appendAssistant = (chunk: string) => {
      accum += chunk;
      updateLastAssistant((last) => {
        const parts = [...(last.parts ?? [])];
        const tail = parts[parts.length - 1];
        if (tail?.type === "text") {
          parts[parts.length - 1] = { ...tail, text: tail.text + chunk };
        } else {
          parts.push({ type: "text", id: newPartId("text"), text: chunk });
        }
        return { ...last, text: accum, parts };
      });
    };
    const appendToolUse = (ev: Extract<ServerEvent, { type: "tool_use" }>) => {
      const id = ev.trace_id || `live-tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const isPageRead = isPageReadTool(ev.name, ev.input);
      const name = effectiveToolName(ev.name, ev.input);
      updateLastAssistant((last) => ({
        ...last,
        parts: isPageRead
          ? [
              ...(last.parts ?? []),
              {
                type: "page_read",
                id,
                name,
                status: "running",
              },
            ]
          : last.parts,
        tools: [
          ...(last.tools ?? []),
          {
            id,
            name,
            input: ev.input,
            status: "running",
            started_at: Date.now() / 1000,
          },
        ],
      }));
    };
    const appendToolResult = (ev: Extract<ServerEvent, { type: "tool_result" }>) => {
      updateLastAssistant((last) => {
        const tools = [...(last.tools ?? [])];
        let idx = ev.trace_id ? tools.findIndex((t) => t.id === ev.trace_id) : -1;
        if (idx === -1) {
          for (let i = tools.length - 1; i >= 0; i -= 1) {
            if (toolStatus(tools[i]) === "running") {
              idx = i;
              break;
            }
          }
        }
        const endedAt = Date.now() / 1000;
        let resolvedId = ev.trace_id;
        if (idx === -1) {
          resolvedId = ev.trace_id || `live-result-${Date.now()}`;
          tools.push({
            id: resolvedId,
            name: "tool_result",
            status: ev.is_error ? "error" : "done",
            is_error: ev.is_error,
            result: ev.text ?? "",
            ended_at: endedAt,
          });
        } else {
          const current = tools[idx];
          resolvedId = current.id;
          const duration =
            typeof current.started_at === "number"
              ? Math.max(0, Math.round((endedAt - current.started_at) * 1000))
              : current.duration_ms;
          tools[idx] = {
            ...current,
            status: ev.is_error ? "error" : "done",
            is_error: ev.is_error,
            result: ev.text ?? "",
            ended_at: endedAt,
            duration_ms: duration,
          };
        }
        const nextStatus: ToolTraceStatus = ev.is_error ? "error" : "done";
        const resolvedTool = resolvedId ? tools.find((tool) => tool.id === resolvedId) : undefined;
        const parts = (last.parts ?? []).map((part) => {
          if (part.type !== "page_read" || part.id !== resolvedId) return part;
          return {
            ...part,
            status: nextStatus,
            is_error: ev.is_error,
            duration_ms: resolvedTool?.duration_ms,
          };
        });
        return { ...last, tools, parts };
      });
    };

    const [ctx, liveSelection] = await Promise.all([
      captureLightContext(lastSentUrl.current, pinnedTarget.current),
      captureCurrentSelection(pinnedTarget.current),
    ]);
    const pageContext =
      ctx && liveSelection ? { ...ctx, selection: liveSelection } : ctx;
    if (ctx?.url) lastSentUrl.current = ctx.url;
    setPageMeta(ctx);
    setSelection(liveSelection);

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
          page_context: pageContext ?? undefined,
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
          } else if (ev.type === "tool_use" && typeof ev.name === "string") {
            appendToolUse(ev);
          } else if (ev.type === "tool_result") {
            appendToolResult(ev);
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
    if (!pageMeta) return "";
    try {
      const host = new URL(pageMeta.url).host;
      return host.replace(/^www\./, "");
    } catch {
      return pageMeta.url || pageMeta.title || "";
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
      <div class="px-3 pt-2 pb-1 flex items-center gap-2 text-[12px] min-h-[34px]">
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
          class="text-bbt-subtle truncate flex-1"
          title={pageMeta ? `${pageMeta.title || ""}\n${pageMeta.url || ""}`.trim() : ""}
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
          class="px-3 pb-1 text-bbt-subtle text-[11px] truncate"
          title={selection}
        >
          {selection.length > 80 ? selection.slice(0, 80) + "…" : selection}
        </div>
      )}

      {/* Chat history */}
      <div ref={scrollRef} class="flex-1 overflow-y-auto px-4 py-2 space-y-4">
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
              {m.parts ? (
                <AssistantParts
                  parts={m.parts}
                  placeholder={streaming && i === msgs.length - 1 ? "…" : ""}
                />
              ) : (
                <>
                  <MarkdownView
                    text={m.text}
                    placeholder={streaming && i === msgs.length - 1 ? "…" : ""}
                  />
                  <PageReadTraceList tools={m.tools} />
                </>
              )}
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

        <div class="bg-bbt-input border border-bbt rounded-2xl flex flex-col shadow-[0_1px_8px_rgba(0,0,0,0.03)]">
          <textarea
            class="resize-none bg-transparent outline-none px-3.5 pt-3 pb-1 text-[14px] leading-6 placeholder:text-bbt-subtle"
            rows={1}
            placeholder="问 babata..."
            value={input}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onPaste={(e) => handlePaste(e as unknown as ClipboardEvent)}
            onKeyDown={(e) => {
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
