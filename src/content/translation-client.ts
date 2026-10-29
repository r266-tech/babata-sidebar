import {
  normalizeTranslationResponse, normalizeTranscriptionResponse,
  type TranslationRequest, type TranslationResponse,
  type TranscriptionRequest, type TranscriptionResponse, type TranscriptionCapabilities,
} from "../translation-protocol";

export type { TranslationRequest, TranslationResponse } from "../translation-protocol";

/** Each caller owns a subscription, not a provider request. Cancelling the last
 * subscriber is propagated through the offscreen document to the companion. */
export function requestTranslation(
  request: TranslationRequest,
  { signal }: { signal?: AbortSignal } = {},
): Promise<TranslationResponse> {
  return requestWithCancellation("babata.translate", request, normalizeTranslationResponse, signal);
}

export function requestTranscription(request: TranscriptionRequest, { signal }: { signal?: AbortSignal } = {}): Promise<TranscriptionResponse> {
  return requestWithCancellation("babata.transcribe", request, normalizeTranscriptionResponse, signal);
}

export async function getTranscriptionCapabilities(): Promise<TranscriptionCapabilities> {
  const response = await chrome.runtime.sendMessage({ type: "babata.transcribe.capabilities" });
  return {
    ok: response?.ok === true,
    available: response?.available === true,
    max_chunk_seconds: typeof response?.max_chunk_seconds === "number" ? response.max_chunk_seconds : 25,
    max_bytes: typeof response?.max_bytes === "number" ? response.max_bytes : 4 * 1024 * 1024,
    ...(typeof response?.error === "string" ? { error: response.error } : {}),
  };
}

function requestWithCancellation<T>(
  type: "babata.translate" | "babata.transcribe",
  request: TranslationRequest | TranscriptionRequest,
  normalize: (response: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Translation cancelled", "AbortError"));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      try { void chrome.runtime.sendMessage({ type: "babata.translate.cancel", request_id: requestId }).catch(() => {}); }
      catch { /* A detached document has no remaining subscriber. */ }
    };
    const finish = (value?: T, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const abort = () => {
      cancel();
      finish(undefined, signal?.reason ?? new DOMException("Translation cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      cancel();
      finish(normalize({ ok: false, results: [], text: "", retryable: true, error: "Translation request timed out" }));
    }, 125_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      void chrome.runtime.sendMessage({ type, ...request, request_id: requestId }).then(
        (response) => finish(normalize(response ?? { ok: false, retryable: true, error: "Translation bridge unavailable" })),
        (error) => { cancel(); finish(undefined, error); },
      );
    } catch (error) { cancel(); finish(undefined, error); }
  });
}
