import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  DEFAULT_SERVER_ORIGIN,
  STORAGE_SERVER_ORIGIN,
  getServerOrigin,
  normalizeServerOrigin,
  serverUrlFromOrigin,
} from "./runtime-config";
import "./styles.css";

type Attachment = {
  id: string;
  kind: "image" | "video" | "file";
  name: string;
  mime: string;
  size: number;
  data_base64: string;
  preview_url?: string;
  thumbnail_data_url?: string;
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

type CpuName = "claude" | "codex";
type CpuChoice = {
  name: CpuName;
  label: string;
  current?: boolean;
  available?: boolean;
};
type CpuStatus = {
  ok: boolean;
  cpu: CpuName;
  label: string;
  choices: CpuChoice[];
  message?: string;
  busy?: boolean;
};
type Suggestion = { id: string; text: string };
type PinnedTarget = { tab_id?: number; window_id?: number };

const SIDEPANEL_PORT = "babata-sidepanel";
const CHAT_HISTORY_KEY_PREFIX = "babata.chat.history.v1";
const CHAT_HISTORY_LATEST_KEY = `${CHAT_HISTORY_KEY_PREFIX}:latest`;
const CHAT_HISTORY_MAX_MESSAGES = 200;
const CHAT_TEXT_MAX_CHARS = 120_000;
const CHAT_TOOL_TEXT_MAX_CHARS = 12_000;
const CHAT_IMAGE_THUMB_MAX_EDGE = 360;
const CHAT_IMAGE_THUMB_MAX_CHARS = 180_000;
const CHAT_DEBUG_PROMPT_MAX_CHARS = 240_000;
const CHAT_DEBUG_PROMPT_MAX_ITEMS = 8;
const STORAGE_DEBUG_PROMPT_ENABLED = "babata.chat.debug_prompt.enabled.v1";

type SavedChatHistory = {
  version: 1;
  updated_at: number;
  messages: Msg[];
  streaming?: boolean;
  active_turn_id?: string;
};

type SavedChatScrollState = {
  version: 1;
  updated_at: number;
  top: number;
  height: number;
  client_height: number;
  bottom_distance: number;
  at_bottom: boolean;
};

marked.setOptions({ breaks: true, gfm: true });

const PAGE_READ_TOOLS = new Set(["tab_metadata", "page_snapshot", "dom_query", "article_extract"]);
const SAFE_MARKDOWN_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const BARE_DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function textField(value: unknown, key: string): string {
  const found = objectField(value, key);
  return typeof found === "string" ? found : "";
}

function nestedObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  const found = objectField(value, key);
  return found && typeof found === "object" && !Array.isArray(found)
    ? found as Record<string, unknown>
    : undefined;
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

function isCpuName(value: unknown): value is CpuName {
  return value === "claude" || value === "codex";
}

function normalizeCpuStatus(raw: unknown): CpuStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!obj.ok || !isCpuName(obj.cpu)) return null;
  const choicesRaw = Array.isArray(obj.choices) ? obj.choices : [];
  const choices = choicesRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .filter((item) => isCpuName(item.name))
    .map((item) => ({
      name: item.name as CpuName,
      label: typeof item.label === "string" ? item.label : String(item.name),
      current: Boolean(item.current),
      available: item.available !== false,
    }));
  return {
    ok: true,
    cpu: obj.cpu,
    label: typeof obj.label === "string" ? obj.label : String(obj.cpu),
    busy: obj.busy === true,
    choices: choices.length > 0 ? choices : [
      { name: "codex", label: "Codex", current: obj.cpu === "codex", available: true },
      { name: "claude", label: "Claude Code", current: obj.cpu === "claude", available: true },
    ],
    message: typeof obj.message === "string" ? obj.message : undefined,
  };
}

function cpuShortLabel(choice: CpuChoice): string {
  return choice.name === "claude" ? "CC" : "Codex";
}

function renderMarkdown(text: string): string {
  if (!text) return "";
  const html = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
  const template = document.createElement("template");
  template.innerHTML = clean;
  for (const anchor of Array.from(template.content.querySelectorAll("a[href]"))) {
    const url = externalMarkdownUrl(anchor.getAttribute("href"));
    if (!url) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
      continue;
    }
    anchor.setAttribute("href", url);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
  return template.innerHTML;
}

function externalMarkdownUrl(rawHref: string | null): string | null {
  const raw = rawHref?.trim() ?? "";
  if (!raw || raw.startsWith("#")) return null;

  try {
    const url = raw.startsWith("//") ? new URL(`https:${raw}`) : new URL(raw);
    return SAFE_MARKDOWN_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    // Continue to bare-domain normalization below.
  }

  if (!BARE_DOMAIN_RE.test(raw)) return null;
  try {
    return new URL(`https://${raw}`).href;
  } catch {
    return null;
  }
}

async function openExternalMarkdownUrl(url: string) {
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function onMarkdownClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const url = externalMarkdownUrl(anchor.getAttribute("href") || anchor.href);
  if (!url) return;
  event.preventDefault();
  event.stopPropagation();
  void openExternalMarkdownUrl(url);
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
  return <div ref={ref} class="bbt-md" onClick={onMarkdownClick} />;
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

function pinnedTargetFromUnknown(raw: unknown): PinnedTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const tab = Number(record.tab_id ?? record.tabId ?? "");
  const win = Number(record.window_id ?? record.windowId ?? "");
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

function chatHistoryStorageKey(windowId?: number): string {
  return typeof windowId === "number" && Number.isFinite(windowId)
    ? `${CHAT_HISTORY_KEY_PREFIX}:window:${windowId}`
    : `${CHAT_HISTORY_KEY_PREFIX}:global`;
}

async function resolveChatHistoryStorageKey(
  target?: PinnedTarget | null,
): Promise<string> {
  if (typeof target?.window_id === "number") {
    return chatHistoryStorageKey(target.window_id);
  }
  const active = await activePageContextFromSw();
  return chatHistoryStorageKey(active?.window_id);
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
  return messages.slice(-CHAT_HISTORY_MAX_MESSAGES).map((msg) => {
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
  });
}

function normalizeStoredMsgs(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  return raw
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
    });
}

function normalizeSavedChatHistory(raw: unknown): SavedChatHistory | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (item.version !== 1 || !Array.isArray(item.messages)) return null;
  return {
    version: 1,
    updated_at: typeof item.updated_at === "number" ? item.updated_at : 0,
    messages: normalizeStoredMsgs(item.messages),
    streaming: item.streaming === true,
    active_turn_id:
      typeof item.active_turn_id === "string" ? item.active_turn_id : undefined,
  };
}

async function readSavedChatHistory(key: string): Promise<SavedChatHistory | null> {
  try {
    const got = await chrome.storage.local.get([key]);
    return normalizeSavedChatHistory(got[key]);
  } catch {
    return null;
  }
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
  await chrome.storage.local.set({
    [key]: record,
    [CHAT_HISTORY_LATEST_KEY]: record,
  });
}

async function clearSavedChatHistory(key: string | null): Promise<void> {
  const keys = key ? [key, CHAT_HISTORY_LATEST_KEY] : [CHAT_HISTORY_LATEST_KEY];
  await chrome.storage.local.remove(keys);
}

function chatStateSignature(messages: Msg[], streaming: boolean): string {
  try {
    return JSON.stringify({ streaming, messages: sanitizeMsgsForStorage(messages) });
  } catch {
    return `${streaming}:${messages.length}`;
  }
}

function chatScrollStorageKey(historyKey: string): string {
  return `${historyKey}:scroll`;
}

function normalizeSavedChatScrollState(raw: unknown): SavedChatScrollState | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (item.version !== 1) return null;
  const top = typeof item.top === "number" ? item.top : 0;
  const height = typeof item.height === "number" ? item.height : 0;
  const clientHeight = typeof item.client_height === "number" ? item.client_height : 0;
  const bottomDistance =
    typeof item.bottom_distance === "number" ? item.bottom_distance : 0;
  return {
    version: 1,
    updated_at: typeof item.updated_at === "number" ? item.updated_at : 0,
    top: Math.max(0, top),
    height: Math.max(0, height),
    client_height: Math.max(0, clientHeight),
    bottom_distance: Math.max(0, bottomDistance),
    at_bottom: item.at_bottom === true,
  };
}

function captureScrollState(el: HTMLElement): SavedChatScrollState {
  const bottomDistance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  return {
    version: 1,
    updated_at: Date.now(),
    top: Math.max(0, el.scrollTop),
    height: Math.max(0, el.scrollHeight),
    client_height: Math.max(0, el.clientHeight),
    bottom_distance: bottomDistance,
    at_bottom: bottomDistance <= 24,
  };
}

async function readSavedChatScrollState(
  historyKey: string,
): Promise<SavedChatScrollState | null> {
  try {
    const got = await chrome.storage.local.get([chatScrollStorageKey(historyKey)]);
    return normalizeSavedChatScrollState(got[chatScrollStorageKey(historyKey)]);
  } catch {
    return null;
  }
}

async function writeSavedChatScrollState(
  historyKey: string,
  state: SavedChatScrollState,
): Promise<void> {
  await chrome.storage.local.set({
    [chatScrollStorageKey(historyKey)]: {
      ...state,
      updated_at: Date.now(),
    },
  });
}

async function clearSavedChatScrollState(historyKey: string | null): Promise<void> {
  if (!historyKey) return;
  await chrome.storage.local.remove([chatScrollStorageKey(historyKey)]);
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

function baseToolName(name: string, input?: unknown): string {
  const effective = effectiveToolName(name, input);
  const parts = effective.split(/[./]/).filter(Boolean);
  return parts[parts.length - 1] || effective;
}

function toolArgs(input?: unknown): Record<string, unknown> | undefined {
  return nestedObjectField(input, "args") ?? nestedObjectField(input, "arguments");
}

function pageReadLabel(name: string, input?: unknown): string {
  const tool = baseToolName(name, input);
  if (tool === "article_extract") return "提取文章";
  if (tool === "page_snapshot") return "扫描页面";
  if (tool === "tab_metadata") return "读取标签页";
  if (tool === "dom_query") {
    const selector = textField(toolArgs(input), "selector");
    if (/article\[data-testid=["']tweet["']\]\s+div\[dir=["']auto["']\]/.test(selector)) {
      return "读取文本节点";
    }
    if (/article\[data-testid=["']tweet["']\]/.test(selector)) return "读取主推文";
    if (selector) return "查询 DOM";
    return "读取页面文本";
  }
  return "读取网页";
}

function pageReadTitle(name: string, input?: unknown): string {
  const label = pageReadLabel(name, input);
  const selector = textField(toolArgs(input), "selector");
  return selector ? `${label}: ${selector}` : `${label}: ${effectiveToolName(name, input)}`;
}

function pageReadText(status: ToolTraceStatus, name: string, input?: unknown): string {
  const label = pageReadLabel(name, input);
  if (status === "running") return `正在${label}`;
  if (status === "error") return `${label}失败`;
  return `已${label}`;
}

function PageReadInline(props: {
  name: string;
  input?: unknown;
  status: ToolTraceStatus;
  duration_ms?: number;
}) {
  return (
    <div class={`bbt-page-read bbt-page-read-${props.status}`} title={pageReadTitle(props.name, props.input)}>
      <span class="bbt-page-read-dot" aria-hidden="true" />
      <span>{pageReadText(props.status, props.name, props.input)}</span>
      {props.duration_ms !== undefined && props.status !== "running" && (
        <span class="bbt-page-read-time">{props.duration_ms}ms</span>
      )}
    </div>
  );
}

function AssistantParts(props: { parts: MessagePart[]; tools?: ToolTrace[]; placeholder?: string }) {
  if (props.parts.length === 0) {
    return <MarkdownView text="" placeholder={props.placeholder} />;
  }
  return (
    <div class="bbt-assistant-flow">
      {props.parts.map((part) => {
        if (part.type === "text") {
          return <MarkdownView key={part.id} text={part.text} />;
        }
        const matchingTool = props.tools?.find((tool) => tool.id === part.id);
        return (
          <PageReadInline
            key={part.id}
            name={part.name}
            input={part.input ?? matchingTool?.input}
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
          name={tool.name}
          input={tool.input}
          status={toolStatus(tool)}
          duration_ms={tool.duration_ms}
        />
      ))}
    </div>
  );
}

function DebugPromptList(props: { prompts?: DebugPromptTrace[] }) {
  const prompts = props.prompts ?? [];
  if (prompts.length === 0) return null;
  return (
    <div class="bbt-debug-prompts">
      {prompts.map((prompt) => {
        const parts = [
          `#${prompt.sequence}`,
          prompt.cpu,
          prompt.allow_tools === undefined
            ? ""
            : prompt.allow_tools
              ? "tools on"
              : "tools off",
          `${prompt.chars.toLocaleString()} chars`,
        ].filter(Boolean);
        return (
          <details key={prompt.id} class="bbt-debug-prompt">
            <summary>
              <span>LLM prompt</span>
              <span class="bbt-debug-meta">{parts.join(" · ")}</span>
            </summary>
            <pre>{prompt.prompt}{prompt.truncated ? `\n\n[truncated: original ${prompt.chars.toLocaleString()} chars]` : ""}</pre>
          </details>
        );
      })}
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

function createImageThumbnail(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) {
      resolve(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    img.onload = () => {
      try {
        const sourceWidth = img.naturalWidth || img.width;
        const sourceHeight = img.naturalHeight || img.height;
        if (sourceWidth <= 0 || sourceHeight <= 0) {
          cleanup();
          resolve(undefined);
          return;
        }
        const scale = Math.min(
          1,
          CHAT_IMAGE_THUMB_MAX_EDGE / Math.max(sourceWidth, sourceHeight),
        );
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          resolve(undefined);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/webp", 0.82);
        cleanup();
        resolve(safeThumbnailDataUrl(dataUrl));
      } catch {
        cleanup();
        resolve(undefined);
      }
    };
    img.onerror = () => {
      cleanup();
      resolve(undefined);
    };
    img.src = url;
  });
}

function attachmentImageSrc(att: Attachment): string {
  if (att.preview_url) return att.preview_url;
  if (att.thumbnail_data_url) return att.thumbnail_data_url;
  if (att.kind === "image" && att.mime.startsWith("image/") && att.data_base64) {
    return `data:${att.mime};base64,${att.data_base64}`;
  }
  return "";
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

function contextNeedsFullPage(meta: LightContext | null, lastUrl: string, lastTitle: string): boolean {
  if (!meta?.url) return false;
  if (!lastUrl) return true;
  if (meta.url !== lastUrl) return true;
  return (meta.title ?? "") !== lastTitle;
}

function contextForTurn(
  meta: LightContext | null,
  selection: string,
  lastUrl: string,
  lastTitle: string,
): LightContext | undefined {
  if (!meta) return undefined;
  const selected = selection.trim();
  const base = contextNeedsFullPage(meta, lastUrl, lastTitle)
    ? meta
    : {
        same_page: true,
        url_changed: false,
        tab_id: meta.tab_id,
        window_id: meta.window_id,
      };
  return selected ? { ...base, selection: selected } : base;
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
  const [serverOrigin, setServerOrigin] = useState(DEFAULT_SERVER_ORIGIN);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [cpuStatus, setCpuStatus] = useState<CpuStatus | null>(null);
  const [cpuSwitching, setCpuSwitching] = useState<CpuName | null>(null);
  const [cpuError, setCpuError] = useState("");
  const [pageMeta, setPageMeta] = useState<LightContext | null>(null);
  const [selection, setSelection] = useState<string>("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSentUrl = useRef<string>("");
  const lastSentTitle = useRef<string>("");
  const pinnedTarget = useRef<PinnedTarget | null>(pinnedTargetFromLocation());
  const msgsRef = useRef<Msg[]>([]);
  const streamingRef = useRef(false);
  const historyStorageKeyRef = useRef<string | null>(null);
  const lastStorageSignatureRef = useRef("");
  const lastWrittenSignatureRef = useRef("");
  const pendingScrollRestoreRef = useRef<SavedChatScrollState | null>(null);
  const scrollRestoreDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const scrollWriteTimerRef = useRef<number | null>(null);
  const [historyStorageKey, setHistoryStorageKey] = useState<string | null>(null);
  const [localHistoryLoaded, setLocalHistoryLoaded] = useState(false);
  const [debugPromptEnabled, setDebugPromptEnabled] = useState(false);

  useEffect(() => {
    msgsRef.current = msgs;
  }, [msgs]);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    historyStorageKeyRef.current = historyStorageKey;
  }, [historyStorageKey]);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local
      .get([STORAGE_DEBUG_PROMPT_ENABLED])
      .then((got) => {
        if (!cancelled) setDebugPromptEnabled(got[STORAGE_DEBUG_PROMPT_ENABLED] === true);
      })
      .catch(() => {});
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local" || !changes[STORAGE_DEBUG_PROMPT_ENABLED]) return;
      setDebugPromptEnabled(changes[STORAGE_DEBUG_PROMPT_ENABLED].newValue === true);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

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
    void getServerOrigin()
      .then((origin) => {
        if (!cancelled) setServerOrigin(origin);
      })
      .catch(() => {});
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local" || !changes[STORAGE_SERVER_ORIGIN]) return;
      setServerOrigin(normalizeServerOrigin(changes[STORAGE_SERVER_ORIGIN].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(serverUrlFromOrigin(serverOrigin, "/health"))
      .then(async (r) => {
        if (!cancelled) setServerOk(r.ok);
        if (!r.ok) return;
        const data = await r.json();
        const status = normalizeCpuStatus(data);
        if (!cancelled && status) {
          setCpuStatus(status);
          if (!status.busy) setCpuError("");
        }
      })
      .catch(() => {
        if (!cancelled) setServerOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverOrigin]);

  useEffect(() => {
    if (!cpuError) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = () => {
      timer = null;
      fetch(serverUrlFromOrigin(serverOrigin, "/health"))
        .then(async (r) => {
          if (cancelled) return;
          setServerOk(r.ok);
          if (!r.ok) {
            timer = window.setTimeout(poll, 2500);
            return;
          }
          const data = await r.json();
          if (cancelled) return;
          const status = normalizeCpuStatus(data);
          if (!status) return;
          setCpuStatus(status);
          if (!status.busy) {
            setCpuError("");
            return;
          }
          timer = window.setTimeout(poll, 1500);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(poll, 2500);
        });
    };
    timer = window.setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [cpuError, serverOrigin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const key = await resolveChatHistoryStorageKey(pinnedTarget.current);
      const [saved, savedScroll] = await Promise.all([
        readSavedChatHistory(key),
        readSavedChatScrollState(key),
      ]);
      if (cancelled) return;
      setHistoryStorageKey(key);
      pendingScrollRestoreRef.current = savedScroll;
      scrollRestoreDoneRef.current = false;
      stickToBottomRef.current = savedScroll ? savedScroll.at_bottom : true;
      if (saved && saved.messages.length > 0) {
        lastStorageSignatureRef.current = chatStateSignature(
          saved.messages,
          saved.streaming === true,
        );
        setMsgs((prev) => (prev.length === 0 ? saved.messages : prev));
        setStreaming(saved.streaming === true);
      }
      setLocalHistoryLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!historyStorageKey || !localHistoryLoaded) return;
    const sig = chatStateSignature(msgs, streaming);
    if (sig === lastStorageSignatureRef.current || sig === lastWrittenSignatureRef.current) return;
    lastWrittenSignatureRef.current = sig;
    writeSavedChatHistory(historyStorageKey, msgs, streaming).catch(() => {});
  }, [historyStorageKey, localHistoryLoaded, msgs, streaming]);

  useEffect(() => {
    if (!historyStorageKey) return;
    const applyRecord = (raw: unknown) => {
      const record = normalizeSavedChatHistory(raw);
      if (!record) return;
      const sig = chatStateSignature(record.messages, record.streaming === true);
      if (sig === chatStateSignature(msgsRef.current, streamingRef.current)) return;
      lastStorageSignatureRef.current = sig;
      setMsgs(record.messages);
      setStreaming(record.streaming === true);
    };
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;
      const changed = changes[historyStorageKey];
      if (!changed || changed.newValue === undefined) return;
      applyRecord(changed.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [historyStorageKey]);

  // Restore chat history on mount/refresh so side panel and popup surfaces stay
  // in sync.
  useEffect(() => {
    if (!localHistoryLoaded) return;
    let cancelled = false;
    fetch(serverUrlFromOrigin(serverOrigin, "/history?limit=200"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
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
  }, [localHistoryLoaded, serverOrigin]);

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
        | { type?: string; action?: string; args?: Record<string, unknown>; tab_id?: number; window_id?: number }
        | undefined;
      if (m?.type === "babata.sidepanel_target") {
        void (async () => {
          const target = pinnedTargetFromUnknown(m);
          if (!target) return;
          const key = await resolveChatHistoryStorageKey(target);
          if (key === historyStorageKeyRef.current) return;
          const [saved, savedScroll] = await Promise.all([
            readSavedChatHistory(key),
            readSavedChatScrollState(key),
          ]);
          pinnedTarget.current = target;
          setHistoryStorageKey(key);
          pendingScrollRestoreRef.current = savedScroll;
          scrollRestoreDoneRef.current = false;
          stickToBottomRef.current = savedScroll ? savedScroll.at_bottom : true;
          if (saved) {
            lastStorageSignatureRef.current = chatStateSignature(
              saved.messages,
              saved.streaming === true,
            );
            setMsgs(saved.messages);
            setStreaming(saved.streaming === true);
          } else {
            lastStorageSignatureRef.current = chatStateSignature([], false);
            setMsgs([]);
            setStreaming(false);
          }
          setLocalHistoryLoaded(true);
        })();
        return;
      }
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
    if (!el || !localHistoryLoaded) return;
    window.requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      if (!scrollRestoreDoneRef.current) {
        const saved = pendingScrollRestoreRef.current;
        pendingScrollRestoreRef.current = null;
        scrollRestoreDoneRef.current = true;
        if (saved) {
          if (saved.at_bottom) {
            current.scrollTop = current.scrollHeight;
          } else {
            const maxTop = Math.max(0, current.scrollHeight - current.clientHeight);
            current.scrollTop = Math.min(saved.top, maxTop);
          }
          return;
        }
      }
      if (stickToBottomRef.current) {
        current.scrollTop = current.scrollHeight;
      }
    });
  }, [localHistoryLoaded, msgs]);

  useEffect(() => {
    return () => {
      if (scrollWriteTimerRef.current !== null) {
        window.clearTimeout(scrollWriteTimerRef.current);
        scrollWriteTimerRef.current = null;
      }
      persistScrollStateNow();
    };
  }, []);

  async function ingestFile(file: File) {
    if (file.size > 50 * 1024 * 1024) {
      alert(`文件太大 (>50MB): ${file.name}`);
      return;
    }
    try {
      const kind = classifyAttachment(file);
      const [data_base64, thumbnail_data_url] = await Promise.all([
        readAsBase64(file),
        kind === "image" ? createImageThumbnail(file) : Promise.resolve(undefined),
      ]);
      const att: Attachment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        name: file.name || "untitled",
        mime: file.type || "application/octet-stream",
        size: file.size,
        data_base64,
        thumbnail_data_url,
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

  function persistScrollStateNow() {
    const key = historyStorageKeyRef.current;
    const el = scrollRef.current;
    if (!key || !el) return;
    const state = captureScrollState(el);
    stickToBottomRef.current = state.at_bottom;
    void writeSavedChatScrollState(key, state).catch(() => {});
  }

  function schedulePersistScrollState() {
    if (scrollWriteTimerRef.current !== null) {
      window.clearTimeout(scrollWriteTimerRef.current);
    }
    scrollWriteTimerRef.current = window.setTimeout(() => {
      scrollWriteTimerRef.current = null;
      persistScrollStateNow();
    }, 120);
  }

  function handleHistoryScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = captureScrollState(el).at_bottom;
    schedulePersistScrollState();
  }

  function toggleDebugPrompt() {
    const next = !debugPromptEnabled;
    setDebugPromptEnabled(next);
    void chrome.storage.local.set({ [STORAGE_DEBUG_PROMPT_ENABLED]: next }).catch(() => {});
  }

  function newSession() {
    if (historyStorageKey) {
      void chrome.runtime
        .sendMessage({ type: "babata.chat.clear", storage_key: historyStorageKey })
        .catch(() => {});
    }
    setMsgs([]);
    setSuggestions([]);
    setInput("");
    setCpuError("");
    setStreaming(false);
    lastSentUrl.current = "";
    lastSentTitle.current = "";
    setAttachments((prev) => {
      prev.forEach((a) => {
        if (a.preview_url) URL.revokeObjectURL(a.preview_url);
      });
      return [];
    });
    void clearSavedChatHistory(historyStorageKey).catch(() => {});
    void clearSavedChatScrollState(historyStorageKey).catch(() => {});
    // 让 server 起新 session: 发 /new 给 cc.py (复用 cc 的 /new 命令路径).
    void fetch(serverUrlFromOrigin(serverOrigin, "/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/new" }),
    }).catch(() => {});
  }

  async function switchCpu(cpu: CpuName) {
    if (cpuSwitching) return;
    if (streaming || cpuStatus?.busy) {
      setCpuError("当前还有 sidebar turn 在跑，等结束后再切 CPU");
      return;
    }
    if (cpu === cpuStatus?.cpu) {
      setCpuError("");
      return;
    }
    setCpuSwitching(cpu);
    setCpuError("");
    try {
      const resp = await fetch(serverUrlFromOrigin(serverOrigin, "/cpu"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cpu }),
      });
      const data = await resp.json().catch(() => null);
      const status = normalizeCpuStatus(data);
      if (!resp.ok || !status) {
        const error =
          data && typeof data === "object" && typeof (data as Record<string, unknown>).error === "string"
            ? String((data as Record<string, unknown>).error)
            : `HTTP ${resp.status}`;
        throw new Error(error);
      }
      setCpuStatus(status);
      setSuggestions([]);
    } catch (e) {
      const m = e as { message?: string };
      setCpuError(m?.message ?? String(e));
    } finally {
      setCpuSwitching(null);
    }
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if ((!text && attachments.length === 0) || streaming) return;

    const sentAttachments = attachments;
    const key = historyStorageKey ?? await resolveChatHistoryStorageKey(pinnedTarget.current);
    if (!historyStorageKey) setHistoryStorageKey(key);
    const userMsg: Msg = { role: "user", text, attachments: sentAttachments };
    const assistantMsg: Msg = { role: "assistant", text: "" };
    const nextMsgs = [...msgsRef.current, userMsg, assistantMsg];
    const pageContext = contextForTurn(
      pageMeta,
      selection,
      lastSentUrl.current,
      lastSentTitle.current,
    );
    if (pageMeta?.url) {
      lastSentUrl.current = pageMeta.url;
      lastSentTitle.current = pageMeta.title ?? "";
    }
    const wireAttachments = sentAttachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      size: a.size,
      data_base64: a.data_base64,
    }));

    setInput("");
    setAttachments([]);
    setSuggestions([]);
    setMsgs(nextMsgs);
    setCpuError("");
    setStreaming(true);

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "babata.chat.start",
        storage_key: key,
        turn_id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message: text,
        messages: sanitizeMsgsForStorage(nextMsgs),
        page_context: pageContext ?? undefined,
        attachments: wireAttachments.length > 0 ? wireAttachments : undefined,
        debug_prompt: debugPromptEnabled,
      }) as { ok?: boolean; error?: string } | undefined;
      if (!resp?.ok) {
        throw new Error(resp?.error || "chat start failed");
      }
    } catch (e) {
      const m = e as { message?: string };
      const errorText = `\n\n[network] ${m?.message ?? String(e)}`;
      setMsgs((current) => {
        const last = current[current.length - 1];
        if (!last || last.role !== "assistant") return current;
        return [
          ...current.slice(0, -1),
          {
            ...last,
            text: `${last.text}${errorText}`,
            parts: [
              ...(last.parts ?? []),
              { type: "text", id: `error-${Date.now()}`, text: errorText },
            ],
          },
        ];
      });
      setStreaming(false);
    }
  }

  function abort() {
    if (historyStorageKey) {
      void chrome.runtime
        .sendMessage({ type: "babata.chat.abort", storage_key: historyStorageKey })
        .catch(() => {});
    }
    setCpuError("");
    setStreaming(false);
  }

  function copyMessage(text: string) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  const headerLine = (() => {
    if (!pageMeta) return "";
    try {
      const host = new URL(pageMeta.url ?? "").host;
      return host.replace(/^www\./, "");
    } catch {
      return pageMeta.url || pageMeta.title || "";
    }
  })();
  const cpuChoices = cpuStatus?.choices ?? [
    { name: "codex" as const, label: "Codex", current: false, available: true },
    { name: "claude" as const, label: "Claude Code", current: false, available: true },
  ];
  const cpuBusy = cpuStatus?.busy === true;
  const cpuSwitchTitle = cpuError || (
    cpuBusy
      ? "当前还有 sidebar turn 在跑，等结束后再切 CPU"
      : cpuStatus
        ? `CPU: ${cpuStatus.label}`
        : "CPU"
  );

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
                : `server 未运行 (${serverOrigin})`
          }
        />
        <span
          class="text-bbt-subtle truncate flex-1"
          title={pageMeta ? `${pageMeta.title || ""}\n${pageMeta.url || ""}`.trim() : ""}
        >
          {headerLine}
        </span>
        <div
          class="bbt-cpu-switch shrink-0"
          title={cpuSwitchTitle}
        >
          {cpuChoices.map((choice) => {
            const active = choice.name === cpuStatus?.cpu;
            const available = choice.available !== false;
            return (
              <button
                key={choice.name}
                class={`bbt-cpu-option ${active ? "bbt-cpu-active" : ""}`}
                onClick={() => switchCpu(choice.name)}
                disabled={streaming || cpuBusy || Boolean(cpuSwitching) || !available}
                title={available ? choice.label : `${choice.label} not found`}
              >
                {cpuSwitching === choice.name ? "..." : cpuShortLabel(choice)}
              </button>
            );
          })}
        </div>
        <button
          class={`btn-icon bbt-debug-toggle w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${
            debugPromptEnabled ? "bbt-debug-toggle-active" : ""
          }`}
          title={debugPromptEnabled ? "Prompt 调试已开" : "Prompt 调试"}
          onClick={toggleDebugPrompt}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5.2 3.2 2.4 6.5l2.8 3.3M8.8 3.2l2.8 3.3-2.8 3.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
            <path d="m7.7 2.8-1.4 7.4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
          </svg>
        </button>
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
      {cpuError && (
        <div class="px-3 pb-1 text-[11px] text-[#9a3f2c] truncate" title={cpuError}>
          CPU: {cpuError}
        </div>
      )}

      {/* Chat history */}
      <div
        ref={scrollRef}
        data-bbt-chat-scroll="true"
        class="flex-1 overflow-y-auto px-4 py-2 space-y-4"
        onScroll={handleHistoryScroll}
      >
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
                      const imageSrc = attachmentImageSrc(a);
                      if (a.kind === "image" && imageSrc) {
                        return (
                          <img
                            key={a.id}
                            src={imageSrc}
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
              <DebugPromptList prompts={m.debug_prompts} />
              {m.parts ? (
                <AssistantParts
                  parts={m.parts}
                  tools={m.tools}
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
                {a.kind === "image" && attachmentImageSrc(a) ? (
                  <img src={attachmentImageSrc(a)} alt="" class="w-7 h-7 object-cover rounded-md" />
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
