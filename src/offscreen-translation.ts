import { normalizeServerOrigin, serverUrlFromOrigin } from "./runtime-config";
import { normalizeTranslationResponse, normalizeTranscriptionResponse, type TranslationResponse, type TranscriptionResponse } from "./translation-protocol";

type Run = { controller: AbortController; tabId?: number; owner: string; kind: "translation" | "transcription" };
const runs = new Map<string, Run>();
const cancelled = new Map<string, number>();
const MAX_RUNS = 128;

function keyOf(message: Record<string, unknown>): string {
  return `${message.owner}:${message.request_id}`;
}

export function abortTranslationRequests(tabId?: number, scope = "all") {
  for (const run of runs.values()) {
    if ((tabId === undefined || run.tabId === tabId) && (scope === "all" || scope === run.kind)) run.controller.abort();
  }
}

export function handleOffscreenTranslation(
  message: Record<string, unknown>,
): Promise<TranslationResponse | TranscriptionResponse | { ok: boolean }> | undefined {
  if (message.type === "babata.offscreen.translation.cancel_tab") {
    if (typeof message.tab_id === "number") abortTranslationRequests(message.tab_id);
    return Promise.resolve({ ok: true });
  }
  if (message.type === "babata.offscreen.translation.cancel_scope") {
    abortTranslationRequests(undefined, String(message.scope));
    return Promise.resolve({ ok: true });
  }
  if (message.type !== "babata.offscreen.translation.request" && message.type !== "babata.offscreen.translation.cancel") return;
  if (typeof message.owner !== "string" || typeof message.request_id !== "string"
    || message.owner.length > 200 || message.request_id.length > 100) {
    return Promise.resolve({ ok: false, results: [], retryable: false, error: "Invalid translation request identity" });
  }
  const key = keyOf(message);
  if (message.type === "babata.offscreen.translation.cancel") {
    runs.get(key)?.controller.abort();
    cancelled.set(key, Date.now());
    for (const [id, time] of cancelled) if (cancelled.size > 512 || time < Date.now() - 120_000) cancelled.delete(id);
    return Promise.resolve({ ok: true });
  }
  return translate(message, key);
}

async function translate(message: Record<string, unknown>, key: string): Promise<TranslationResponse | TranscriptionResponse> {
  const cancelledResponse: TranslationResponse = { ok: false, results: [], aborted: true, retryable: false, error: "Translation cancelled" };
  if (cancelled.has(key)) { cancelled.delete(key); return cancelledResponse; }
  if (runs.has(key)) return { ok: false, results: [], retryable: false, error: "Duplicate translation request identity" };
  if (runs.size >= MAX_RUNS) return { ok: false, results: [], retryable: true, retry_after_ms: 500, error: "Translation queue is full" };
  if (!message.payload || typeof message.payload !== "object" || typeof message.origin !== "string") {
    return { ok: false, results: [], retryable: false, error: "Invalid translation payload" };
  }
  const controller = new AbortController();
  const run: Run = { controller, owner: String(message.owner), tabId: typeof message.tab_id === "number" ? message.tab_id : undefined,
    kind: message.endpoint === "/transcribe" ? "transcription" : "translation" };
  runs.set(key, run);
  let deadlineExceeded = false;
  const timer = window.setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new Error("Translation deadline exceeded"));
  }, 120_000);
  try {
    const endpoint = message.endpoint === "/transcribe" ? "/transcribe" : "/translate";
    const response = await fetch(serverUrlFromOrigin(normalizeServerOrigin(message.origin), endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-babata-extension-origin": `chrome-extension://${chrome.runtime.id}`,
        "x-babata-client-id": typeof message.client_id === "string" ? message.client_id : "",
      },
      body: JSON.stringify(message.payload),
      signal: controller.signal,
    });
    const value = await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return { ok: false, error: "Companion returned an invalid translation response", retryable: false };
    });
    controller.signal.throwIfAborted();
    const result = endpoint === "/transcribe" ? normalizeTranscriptionResponse(value, response.status) : normalizeTranslationResponse(value, response.status);
    if (result.retry_after_ms === undefined) {
      const retry = response.headers.get("retry-after");
      if (retry) {
        const seconds = Number(retry);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        if (Number.isFinite(wait)) result.retry_after_ms = Math.max(0, wait);
      }
    }
    return result;
  } catch (error) {
    if (deadlineExceeded) return { ok: false, results: [], retryable: true, error: "Translation request timed out" };
    if (controller.signal.aborted) return cancelledResponse;
    return { ok: false, results: [], retryable: true, error: (error as Error).message || "Translation connection failed" };
  } finally {
    window.clearTimeout(timer);
    if (runs.get(key) === run) runs.delete(key);
  }
}
