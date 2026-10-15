/// <reference types="chrome" />
import { boundDebugPromptHistory } from "./chat-debug-history";

import {
  DEFAULT_SERVER_ORIGIN,
  normalizeServerOrigin,
  serverUrlFromOrigin,
  wsUrlFromOrigin,
} from "./runtime-config";

// Offscreen document — 持久 ws 通道 (MV3 SW idle 30s kill 不杀这).
//
// 哲学: SW 是 dispatcher (chrome.scripting.executeScript 等只能 SW 跑),
// offscreen 是长连透 (ws). 双向消息走 chrome.runtime.sendMessage 流转:
//   server WS  ──→ offscreen ──→ SW (handle, 跑 chrome.scripting) ──→ offscreen ──→ server WS
//   server WS notification ──→ offscreen ──→ SW ──→ sidepanel (通知 chip 等)
//
// This keeps the long-lived channel outside the service worker idle lifecycle.

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const SW_KEEPALIVE_MS = 20_000;
const CHAT_HISTORY_KEY_PREFIX = "babata.chat.history.v1";
const CHAT_HISTORY_LATEST_KEY = `${CHAT_HISTORY_KEY_PREFIX}:latest`;
const CHAT_HISTORY_MAX_MESSAGES = 200;
const CHAT_TEXT_MAX_CHARS = 120_000;
const CHAT_TOOL_TEXT_MAX_CHARS = 12_000;
const CHAT_IMAGE_THUMB_MAX_CHARS = 180_000;
const CHAT_FLUSH_MS = 120;
const CHAT_MODEL_MAX_MESSAGES = 24;
const CHAT_MODEL_TEXT_MAX_CHARS = 8_000;
const CHAT_DEBUG_PROMPT_MAX_CHARS = 240_000;
const CHAT_DEBUG_PROMPT_MAX_ITEMS = 8;

type Attachment = {
  id: string;
  kind: "image" | "video" | "file";
  name: string;
  mime: string;
  size: number;
  data_base64: string;
  thumbnail_data_url?: string;
};

type WireAttachment = {
  kind: Attachment["kind"];
  name: string;
  mime: string;
  size: number;
  data_base64: string;
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

type DebugPromptTrace = {
  id: string;
  sequence: number;
  cpu?: string;
  allow_tools?: boolean;
  tool_results_count?: number;
  chars: number;
  prompt: string;
  truncated?: boolean;
  created_at: number;
};

type MessagePart =
  | { type: "text"; id: string; text: string }
  | {
      type: "page_read";
      id: string;
      name: string;
      input?: unknown;
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
  debug_prompts?: DebugPromptTrace[];
  clean_read_id?: string;
  pending?: boolean;
};

type LightContext = {
  url?: string;
  title?: string;
  url_changed: boolean;
  same_page?: boolean;
  tab_id?: number;
  window_id?: number;
  selection?: string;
};

type ServerEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "debug_prompt";
      sequence?: number;
      cpu?: string;
      allow_tools?: boolean;
      tool_results_count?: number;
      chars?: number;
      prompt: string;
    }
  | { type: "tool_use"; trace_id?: string; name: string; input?: unknown }
  | { type: "tool_result"; trace_id?: string; is_error?: boolean; text?: string }
  | { type: "session"; session_id: string }
  | { type: "done" }
  | { type: "error"; text: string };

type SavedChatHistory = {
  version: 1;
  updated_at: number;
  messages: Msg[];
  streaming?: boolean;
  active_turn_id?: string;
};

type ChatStartMessage = {
  type: "babata.offscreen.chat.start";
  storage_key: string;
  turn_id?: string;
  message: string;
  messages?: unknown;
  page_context?: LightContext;
  attachments?: WireAttachment[];
  debug_prompt?: boolean;
  cpu?: string;
};

type ActiveChatRun = {
  key: string;
  turnId: string;
  controller: AbortController;
  messages: Msg[];
  discard: boolean;
  finished: Promise<void>;
};

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: number | null = null;
let activeServerOrigin = DEFAULT_SERVER_ORIGIN;
let browserClientId = "";
let connecting = false;
let connectionGeneration = 0;
let bridgeConnectionId = "";
const activeChatRuns = new Map<string, ActiveChatRun>();

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

function toolStatus(t: ToolTrace): ToolTraceStatus {
  if (t.status === "error" || t.is_error) return "error";
  if (t.status === "done") return "done";
  return "running";
}

function truncateText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? value.slice(0, limit) : value;
}

function storageSafeUnknown(value: unknown, limit: number): unknown {
  if (typeof value === "string") return truncateText(value, limit);
  if (value === null || value === undefined) return value;
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length <= limit) return value;
    return encoded.slice(0, limit);
  } catch {
    return truncateText(String(value), limit);
  }
}

function normalizeMessagePart(raw: unknown, index: number): MessagePart | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : `stored-part-${index + 1}`;
  if (item.type === "text") {
    return {
      type: "text",
      id,
      text: truncateText(item.text, CHAT_TEXT_MAX_CHARS),
    };
  }
  if (item.type === "page_read") {
    const status =
      item.status === "running" || item.status === "done" || item.status === "error"
        ? item.status
        : "done";
    return {
      type: "page_read",
      id,
      name: typeof item.name === "string" ? item.name : "page_read",
      input: storageSafeUnknown(item.input, CHAT_TOOL_TEXT_MAX_CHARS),
      status,
      is_error: item.is_error === true,
      duration_ms: typeof item.duration_ms === "number" ? item.duration_ms : undefined,
    };
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

function safeThumbnailDataUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("data:image/")) return undefined;
  return value.length <= CHAT_IMAGE_THUMB_MAX_CHARS ? value : undefined;
}

function sanitizeAttachmentForStorage(raw: Attachment): Attachment {
  const out: Attachment = {
    id: raw.id,
    kind: raw.kind,
    name: raw.name,
    mime: raw.mime,
    size: raw.size,
    data_base64: "",
  };
  const thumbnail = safeThumbnailDataUrl(raw.thumbnail_data_url);
  if (thumbnail) out.thumbnail_data_url = thumbnail;
  return out;
}

function sanitizeToolsForStorage(raw: unknown): ToolTrace[] {
  return normalizeToolTrace(raw).map((tool) => ({
    ...tool,
    input: storageSafeUnknown(tool.input, CHAT_TOOL_TEXT_MAX_CHARS),
    result: truncateText(tool.result, CHAT_TOOL_TEXT_MAX_CHARS) || undefined,
  }));
}

function normalizeDebugPromptTrace(raw: unknown, index: number): DebugPromptTrace | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const prompt = truncateText(item.prompt, CHAT_DEBUG_PROMPT_MAX_CHARS);
  if (!prompt) return null;
  const chars = typeof item.chars === "number" && Number.isFinite(item.chars)
    ? item.chars
    : prompt.length;
  const sequence = typeof item.sequence === "number" && Number.isFinite(item.sequence)
    ? item.sequence
    : index + 1;
  const createdAt = typeof item.created_at === "number" && Number.isFinite(item.created_at)
    ? item.created_at
    : Date.now();
  return {
    id: typeof item.id === "string" ? item.id : `debug-prompt-${sequence}-${createdAt}`,
    sequence,
    cpu: typeof item.cpu === "string" ? item.cpu : undefined,
    allow_tools: typeof item.allow_tools === "boolean" ? item.allow_tools : undefined,
    tool_results_count:
      typeof item.tool_results_count === "number" && Number.isFinite(item.tool_results_count)
        ? item.tool_results_count
        : undefined,
    chars,
    prompt,
    truncated: item.truncated === true || chars > prompt.length,
    created_at: createdAt,
  };
}

function sanitizeDebugPromptsForStorage(raw: unknown): DebugPromptTrace[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => normalizeDebugPromptTrace(item, index))
    .filter((item): item is DebugPromptTrace => item !== null)
    .slice(-CHAT_DEBUG_PROMPT_MAX_ITEMS);
}

function sanitizeMsgsForStorage(messages: Msg[]): Msg[] {
  return boundDebugPromptHistory(messages.slice(-CHAT_HISTORY_MAX_MESSAGES).map((msg) => {
    const out: Msg = {
      role: msg.role,
      text: truncateText(msg.text, CHAT_TEXT_MAX_CHARS),
    };
    const parts = (msg.parts ?? [])
      .map((part, index) => normalizeMessagePart(part, index))
      .filter((part): part is MessagePart => part !== null);
    if (parts.length > 0) out.parts = parts;
    const attachments = (msg.attachments ?? []).map(sanitizeAttachmentForStorage);
    if (attachments.length > 0) out.attachments = attachments;
    const tools = sanitizeToolsForStorage(msg.tools);
    if (tools.length > 0) out.tools = tools;
    const debugPrompts = sanitizeDebugPromptsForStorage(msg.debug_prompts);
    if (debugPrompts.length > 0) out.debug_prompts = debugPrompts;
    if (typeof msg.clean_read_id === "string") out.clean_read_id = msg.clean_read_id;
    if (msg.pending) out.pending = true;
    return out;
  }));
}

function msgsForModelWire(messages: Msg[]): Array<{ role: Msg["role"]; text: string }> {
  return messages
    .slice(-CHAT_MODEL_MAX_MESSAGES)
    .map((msg) => ({
      role: msg.role,
      text: truncateText(msg.text, CHAT_MODEL_TEXT_MAX_CHARS),
    }))
    .filter((msg) => msg.text.trim().length > 0);
}

function normalizeStoredMsgs(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  return boundDebugPromptHistory(raw
    .slice(-CHAT_HISTORY_MAX_MESSAGES)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => {
      const msg: Msg = {
        role: item.role as "user" | "assistant",
        text: truncateText(item.text, CHAT_TEXT_MAX_CHARS),
      };
      const parts = Array.isArray(item.parts)
        ? item.parts
          .map((part, index) => normalizeMessagePart(part, index))
          .filter((part): part is MessagePart => part !== null)
        : [];
      if (parts.length > 0) msg.parts = parts;
      const attachments = Array.isArray(item.attachments)
        ? item.attachments
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .filter((a) => a.kind === "image" || a.kind === "video" || a.kind === "file")
          .map((a, index) => {
            const att: Attachment = {
              id: typeof a.id === "string" ? a.id : `stored-attachment-${index + 1}`,
              kind: a.kind as Attachment["kind"],
              name: typeof a.name === "string" ? a.name : "attachment",
              mime: typeof a.mime === "string" ? a.mime : "application/octet-stream",
              size: typeof a.size === "number" ? a.size : 0,
              data_base64: "",
            };
            const thumbnail = safeThumbnailDataUrl(a.thumbnail_data_url);
            if (thumbnail) att.thumbnail_data_url = thumbnail;
            return att;
          })
        : [];
      if (attachments.length > 0) msg.attachments = attachments;
      const tools = sanitizeToolsForStorage(item.tools);
      if (tools.length > 0) msg.tools = tools;
      const debugPrompts = sanitizeDebugPromptsForStorage(item.debug_prompts);
      if (debugPrompts.length > 0) msg.debug_prompts = debugPrompts;
      if (typeof item.clean_read_id === "string") msg.clean_read_id = item.clean_read_id;
      if (item.pending === true) msg.pending = true;
      return msg;
    }));
}

async function writeSavedChatHistory(
  key: string,
  messages: Msg[],
  streaming = false,
  activeTurnId?: string,
): Promise<void> {
  const record: SavedChatHistory = {
    version: 1,
    updated_at: Date.now(),
    messages: sanitizeMsgsForStorage(messages),
    streaming,
    active_turn_id: activeTurnId,
  };
  const resp = await chrome.runtime.sendMessage({
    type: "babata.chat.snapshot_write",
    storage_key: key,
    latest_key: CHAT_HISTORY_LATEST_KEY,
    record,
  }) as { ok?: boolean; error?: string } | undefined;
  if (!resp?.ok) throw new Error(resp?.error || "snapshot write failed");
}

async function clearSavedChatHistory(key: string): Promise<void> {
  const resp = await chrome.runtime.sendMessage({
    type: "babata.chat.snapshot_clear",
    storage_key: key,
    latest_key: CHAT_HISTORY_LATEST_KEY,
  }) as { ok?: boolean; error?: string } | undefined;
  if (!resp?.ok) throw new Error(resp?.error || "snapshot clear failed");
}

function updateLastAssistant(messages: Msg[], fn: (msg: Msg) => Msg): Msg[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), fn(last)];
}

function appendAssistant(messages: Msg[], chunk: string): Msg[] {
  return updateLastAssistant(messages, (last) => {
    const parts = [...(last.parts ?? [])];
    const tail = parts[parts.length - 1];
    if (tail?.type === "text") {
      parts[parts.length - 1] = { ...tail, text: tail.text + chunk };
    } else {
      parts.push({ type: "text", id: newPartId("text"), text: chunk });
    }
    return { ...last, text: `${last.text}${chunk}`, parts };
  });
}

function appendToolUse(
  messages: Msg[],
  ev: Extract<ServerEvent, { type: "tool_use" }>,
): Msg[] {
  const id = ev.trace_id || `live-tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const isPageRead = isPageReadTool(ev.name, ev.input);
  const name = effectiveToolName(ev.name, ev.input);
  return updateLastAssistant(messages, (last) => ({
    ...last,
    parts: isPageRead
      ? [
          ...(last.parts ?? []),
          {
            type: "page_read",
            id,
            name,
            input: ev.input,
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
}

function appendToolResult(
  messages: Msg[],
  ev: Extract<ServerEvent, { type: "tool_result" }>,
): Msg[] {
  return updateLastAssistant(messages, (last) => {
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
}

function appendDebugPrompt(
  messages: Msg[],
  ev: Extract<ServerEvent, { type: "debug_prompt" }>,
): Msg[] {
  const prompt = truncateText(ev.prompt, CHAT_DEBUG_PROMPT_MAX_CHARS);
  if (!prompt) return messages;
  const chars = typeof ev.chars === "number" && Number.isFinite(ev.chars)
    ? ev.chars
    : ev.prompt.length;
  const sequence = typeof ev.sequence === "number" && Number.isFinite(ev.sequence)
    ? ev.sequence
    : 1;
  const createdAt = Date.now();
  const trace: DebugPromptTrace = {
    id: `debug-prompt-${sequence}-${createdAt}`,
    sequence,
    cpu: typeof ev.cpu === "string" ? ev.cpu : undefined,
    allow_tools: typeof ev.allow_tools === "boolean" ? ev.allow_tools : undefined,
    tool_results_count:
      typeof ev.tool_results_count === "number" && Number.isFinite(ev.tool_results_count)
        ? ev.tool_results_count
        : undefined,
    chars,
    prompt,
    truncated: chars > prompt.length,
    created_at: createdAt,
  };
  return updateLastAssistant(messages, (last) => ({
    ...last,
    debug_prompts: [
      ...(last.debug_prompts ?? []),
      trace,
    ].slice(-CHAT_DEBUG_PROMPT_MAX_ITEMS),
  }));
}

function normalizeChatStartMessage(msg: unknown): ChatStartMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const item = msg as Record<string, unknown>;
  if (
    item.type !== "babata.offscreen.chat.start" ||
    !storageKeyFromMessage(msg) ||
    typeof item.message !== "string"
  ) {
    return null;
  }
  const pageContext =
    item.page_context && typeof item.page_context === "object"
      ? item.page_context as LightContext
      : undefined;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .filter((a) => a.kind === "image" || a.kind === "video" || a.kind === "file")
      .map((a) => ({
        kind: a.kind as Attachment["kind"],
        name: typeof a.name === "string" ? a.name : "attachment",
        mime: typeof a.mime === "string" ? a.mime : "application/octet-stream",
        size: typeof a.size === "number" ? a.size : 0,
        data_base64: "",
      }))
    : undefined;
  return {
    type: "babata.offscreen.chat.start",
    storage_key: item.storage_key as string,
    turn_id: typeof item.turn_id === "string" ? item.turn_id : undefined,
    message: item.message,
    messages: item.messages,
    page_context: pageContext,
    attachments,
    debug_prompt: item.debug_prompt === true,
    cpu: typeof item.cpu === "string" ? item.cpu : undefined,
  };
}

function storageKeyFromMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const key = (msg as Record<string, unknown>).storage_key;
  return typeof key === "string" && key.startsWith(CHAT_HISTORY_KEY_PREFIX) ? key : null;
}

async function abortChat(key: string): Promise<void> {
  const run = activeChatRuns.get(key);
  if (run) {
    run.controller.abort();
    await run.finished;
    return;
  }
  const resp = await chrome.runtime.sendMessage({
    type: "babata.chat.snapshot_mark_stopped",
    storage_key: key,
    latest_key: CHAT_HISTORY_LATEST_KEY,
  }) as { ok?: boolean; error?: string } | undefined;
  if (!resp?.ok) throw new Error(resp?.error || "snapshot mark stopped failed");
}

async function clearChat(key: string): Promise<void> {
  const run = activeChatRuns.get(key);
  if (run) {
    run.discard = true;
    activeChatRuns.delete(key);
    run.controller.abort();
    await run.finished;
  }
  if (!activeChatRuns.has(key)) await clearSavedChatHistory(key);
}

async function startChat(req: ChatStartMessage, acknowledge: (result: { ok: boolean; error?: string }) => void): Promise<void> {
  const key = req.storage_key;
  const previous = activeChatRuns.get(key);
  if (previous) {
    previous.discard = true;
    activeChatRuns.delete(key);
    previous.controller.abort();
  }

  const turnId = req.turn_id || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messages = normalizeStoredMsgs(req.messages);
  if (messages.length === 0 || messages[messages.length - 1]?.role !== "assistant") {
    messages.push({ role: "assistant", text: "" });
  }

  let finishRun!: () => void;
  const run: ActiveChatRun = {
    key,
    turnId,
    controller: new AbortController(),
    messages,
    discard: false,
    finished: new Promise<void>((resolve) => { finishRun = resolve; }),
  };
  activeChatRuns.set(key, run);

  let streaming = true;
  let acknowledged = false;
  let flushTimer: number | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const isCurrentRun = () => activeChatRuns.get(key)?.turnId === turnId && !run.discard;
  const enqueueWrite = () => {
    const messages = run.messages;
    const streamingSnapshot = streaming;
    writeChain = writeChain
      .catch(() => {})
      .then(() => isCurrentRun() ? writeSavedChatHistory(key, messages, streamingSnapshot, turnId) : undefined)
      .catch((e) => {
        console.warn("[babata-offscreen] chat snapshot write failed", e);
        if (isCurrentRun()) {
          // A failed disk write must not leave an open panel stuck on Stop or
          // silently hide its final answer. Keep the live copy visible, with a
          // clear warning that reload recovery is not guaranteed.
          void chrome.runtime.sendMessage({
            type: "babata.chat.snapshot_error",
            storage_key: key,
            turn_id: turnId,
            messages: sanitizeMsgsForStorage(messages),
            streaming: streamingSnapshot,
            error: `聊天记录保存失败：${(e as Error)?.message ?? String(e)}。当前内容可能无法在重载后恢复。`,
          }).catch(() => {});
        }
      });
    return writeChain;
  };
  const flush = (force = false): Promise<void> | undefined => {
    if (!isCurrentRun()) return undefined;
    if (force && flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!force && flushTimer !== null) return undefined;
    const write = () => {
      if (!isCurrentRun()) return;
      void enqueueWrite();
    };
    if (force) {
      return enqueueWrite();
    } else {
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        write();
      }, CHAT_FLUSH_MS);
      return undefined;
    }
  };

  try {
    await previous?.finished;
    if (!isCurrentRun()) throw new Error("chat cancelled before start");
    await writeSavedChatHistory(key, run.messages, true, turnId);
    acknowledged = true;
    acknowledge({ ok: true });
    if (!isCurrentRun()) return;
    const routing = await readServerRoutingFromSw();
    if (!isCurrentRun()) return;
    const resp = await fetch(serverUrlFromOrigin(routing.origin, "/chat"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-babata-client-id": routing.clientId },
      body: JSON.stringify({
        message: req.message,
        messages: msgsForModelWire(run.messages),
        page_context: req.page_context ?? undefined,
        attachments: req.attachments && req.attachments.length > 0 ? req.attachments : undefined,
        debug_prompt: req.debug_prompt === true,
        cpu: req.cpu,
        conversation_id: key,
      }),
      signal: run.controller.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawDone = false;
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
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "text_delta" && typeof ev.text === "string") {
          run.messages = appendAssistant(run.messages, ev.text);
          flush();
        } else if (ev.type === "debug_prompt" && typeof ev.prompt === "string") {
          run.messages = appendDebugPrompt(run.messages, ev);
          flush(true);
        } else if (ev.type === "tool_use" && typeof ev.name === "string") {
          run.messages = appendToolUse(run.messages, ev);
          flush(true);
        } else if (ev.type === "tool_result") {
          run.messages = appendToolResult(run.messages, ev);
          flush(true);
        } else if (ev.type === "error" && typeof ev.text === "string") {
          run.messages = appendAssistant(run.messages, `\n\n[err] ${ev.text}`);
          flush(true);
        } else if (ev.type === "done") {
          sawDone = true;
        }
      }
    }
    if (sawDone) {
      streaming = false;
      await flush(true);
    } else {
      throw new Error("chat stream ended before completion");
    }
  } catch (e) {
    const m = e as { name?: string; message?: string };
    if (!acknowledged) acknowledge({ ok: false, error: m?.message ?? String(e) });
    if (m?.name !== "AbortError" && isCurrentRun()) {
      run.messages = appendAssistant(run.messages, `\n\n[network] ${m?.message ?? String(e)}`);
    }
  } finally {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (isCurrentRun()) {
      streaming = false;
      run.messages = updateLastAssistant(run.messages, (last) => ({
        ...last,
        tools: last.tools?.map((tool) => tool.status === "running"
          ? { ...tool, status: "error", is_error: true, result: "操作已中止" }
          : tool),
        parts: last.parts?.map((part) => part.type === "page_read" && part.status === "running"
          ? { ...part, status: "error", is_error: true }
          : part),
      }));
      await enqueueWrite();
      if (isCurrentRun()) activeChatRuns.delete(key);
    }
    await writeChain;
    finishRun();
  }
}

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

async function readServerRoutingFromSw(): Promise<{ origin: string; clientId: string }> {
  const resp = await chrome.runtime.sendMessage({ type: "babata.server_origin.get" }) as
    | { ok?: boolean; origin?: string; client_id?: string }
    | undefined;
  if (!resp?.ok || !resp.client_id) throw new Error("companion routing unavailable");
  return { origin: normalizeServerOrigin(resp.origin), clientId: resp.client_id };
}

function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const generation = connectionGeneration;
  void (async () => {
    connecting = true;
    const routing = await readServerRoutingFromSw();
    if (generation !== connectionGeneration) return;
    activeServerOrigin = routing.origin;
    browserClientId = routing.clientId;
    const url = new URL(wsUrlFromOrigin(activeServerOrigin));
    url.searchParams.set("client_id", browserClientId);
    const socket = new WebSocket(url);
    ws = socket;
    attachWsHandlers(socket);
  })().catch(() => {
    if (generation === connectionGeneration) scheduleReconnect();
  }).finally(() => {
    connecting = false;
    if (generation !== connectionGeneration) connect();
  });
}

function attachWsHandlers(socket: WebSocket) {
  const connectionId = crypto.randomUUID();
  bridgeConnectionId = connectionId;
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    console.log("[babata-offscreen] ws connected");
  });
  socket.addEventListener("close", () => {
    console.log("[babata-offscreen] ws closed");
    if (ws === socket) { ws = null; scheduleReconnect(); }
  });
  socket.addEventListener("error", () => {
    /* close handler 触发 reconnect */
  });
  socket.addEventListener("message", (ev) => {
    if (ws !== socket) return;
    // forward 到 SW. SW cold-start 时 sendMessage reject (no receiver), 100ms
    // 后重试一次 — 不重试就 server 等 30s timeout, request 白丢.
    const payload = typeof ev.data === "string" ? ev.data : "";
    const send = () => ws === socket
      ? chrome.runtime.sendMessage({
        type: "babata.ws.inbound",
        payload,
        connection_id: connectionId,
      })
      : Promise.resolve();
    send().catch(() => {
      window.setTimeout(() => {
        send().catch((e) => {
          console.warn(
            "[babata-offscreen] inbound dispatch failed twice:",
            (e as Error)?.message ?? e,
          );
        });
      }, 100);
    });
  });
}

function reconnectToServerOrigin(origin: string) {
  const normalized = normalizeServerOrigin(origin);
  connectionGeneration += 1;
  if (normalized !== activeServerOrigin) {
    for (const run of activeChatRuns.values()) run.controller.abort();
  }
  bridgeConnectionId = "";
  activeServerOrigin = normalized;
  reconnectAttempt = 0;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = ws;
  ws = null;
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
  connect();
}

// SW 想发消息出去, 通过 chrome.runtime.sendMessage with type babata.ws.outbound
// 转给我 — 我 ws.send. SW 没 ws 引用, 必须经我.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  const m = msg as { type?: string; payload?: string; origin?: string; connection_id?: string };
  if (m.type === "babata.server_origin.changed") {
    reconnectToServerOrigin(m.origin ?? DEFAULT_SERVER_ORIGIN);
    sendResponse?.({ ok: true });
    return false;
  }
  if (m.type === "babata.ws.outbound" && typeof m.payload === "string") {
    if (m.connection_id !== bridgeConnectionId) return false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(m.payload);
      } catch (e) {
        console.warn("[babata-offscreen] ws.send failed", e);
      }
    } else {
      console.warn("[babata-offscreen] outbound dropped: ws not open");
    }
    return false;
  }

  if (m.type === "babata.offscreen.chat.start") {
    const req = normalizeChatStartMessage(msg);
    if (!req) {
      sendResponse?.({ ok: false, error: "invalid chat start" });
      return false;
    }
    void startChat(req, (result) => sendResponse?.(result))
      .catch((e) => {
        console.warn("[babata-offscreen] chat start failed", e);
        sendResponse?.({ ok: false, error: (e as Error).message });
      });
    return true;
  }

  if (m.type === "babata.offscreen.chat.status") {
    const key = storageKeyFromMessage(msg);
    const run = key ? activeChatRuns.get(key) : undefined;
    sendResponse?.({ ok: true, streaming: !!run && !run.controller.signal.aborted, turn_id: run?.turnId });
    return false;
  }

  if (m.type === "babata.offscreen.chat.abort") {
    const key = storageKeyFromMessage(msg);
    if (!key) {
      sendResponse?.({ ok: false, error: "invalid storage key" });
      return false;
    }
    void abortChat(key)
      .then(() => sendResponse?.({ ok: true }))
      .catch((e) => sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) }));
    return true;
  }

  if (m.type === "babata.offscreen.chat.clear") {
    const key = storageKeyFromMessage(msg);
    if (!key) {
      sendResponse?.({ ok: false, error: "invalid storage key" });
      return false;
    }
    void clearChat(key)
      .then(() => sendResponse?.({ ok: true }))
      .catch((e) => sendResponse?.({ ok: false, error: (e as Error).message ?? String(e) }));
    return true;
  }
  return false;
});

// SW keepalive — 20s 一次 ping, 让 SW 的 idle timer 重置. SW 收到这个 message
// 就被算 "活动", 不会被 30s idle kill. (Anthropic 1.0.70 offscreen.js 同手法.)
window.setInterval(() => {
  chrome.runtime.sendMessage({ type: "babata.keepalive" }).catch(() => {});
}, SW_KEEPALIVE_MS);

connect();

export {};
