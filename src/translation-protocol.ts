export type TranslationPriority = "interactive" | "subtitle" | "visible" | "prefetch";
export type TranslationItem = { hash: string; text: string };
export type TranslationResult = { hash: string; translated: string };
export type TranslationError = {
  hash: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  retry_after_ms?: number;
};
export type TranslationRequest = {
  batch: TranslationItem[];
  target?: string;
  site?: string;
  url?: string;
  priority?: TranslationPriority;
};
export type TranslationResponse = {
  ok: boolean;
  results: TranslationResult[];
  complete?: boolean;
  partial?: boolean;
  errors?: TranslationError[];
  missing?: string[];
  error?: string;
  retryable?: boolean;
  retry_after_ms?: number;
  aborted?: boolean;
};

export type TranscriptionRequest = {
  audio_base64: string;
  mime: string;
  duration_seconds: number;
  source?: string;
  target?: string;
  sequence?: number;
};
export type TranscriptionResponse = {
  ok: boolean;
  text: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  error?: string;
  retryable?: boolean;
  retry_after_ms?: number;
  aborted?: boolean;
};
export type TranscriptionCapabilities = {
  ok: boolean;
  available: boolean;
  max_chunk_seconds: number;
  max_bytes: number;
  error?: string;
};

export function normalizeTranscriptionResponse(value: unknown, status = 200): TranscriptionResponse {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    ok: status >= 200 && status < 300 && data.ok === true && typeof data.text === "string",
    text: typeof data.text === "string" ? data.text : "",
    ...(typeof data.language === "string" ? { language: data.language } : {}),
    ...(Array.isArray(data.segments) ? { segments: data.segments.filter((item) => item
      && typeof item.text === "string" && Number.isFinite(item.start) && Number.isFinite(item.end)
      && item.start >= 0 && item.end > item.start).map((item) => ({ start: item.start, end: item.end, text: item.text })) } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : status >= 400 ? { error: `HTTP ${status}` } : {}),
    retryable: typeof data.retryable === "boolean" ? data.retryable : [408, 425, 429, 500, 502, 503, 504].includes(status),
    ...(Number.isFinite(data.retry_after_ms) && Number(data.retry_after_ms) >= 0 ? { retry_after_ms: Number(data.retry_after_ms) } : {}),
    ...(data.aborted === true ? { aborted: true } : {}),
  };
}

/** Preserve valid partial results, while never trusting model or bridge shapes. */
export function normalizeTranslationResponse(value: unknown, status = 200): TranslationResponse {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const results: TranslationResult[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data.results) ? data.results : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.hash !== "string" || typeof item.translated !== "string" || !item.translated.trim() || seen.has(item.hash)) continue;
    seen.add(item.hash);
    results.push({ hash: item.hash, translated: item.translated });
  }
  const errors: TranslationError[] = [];
  for (const raw of Array.isArray(data.errors) ? data.errors : []) {
    if (!raw || typeof raw !== "object" || typeof raw.hash !== "string") continue;
    errors.push({
      hash: raw.hash,
      ...(typeof raw.code === "string" ? { code: raw.code } : {}),
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      ...(typeof raw.retryable === "boolean" ? { retryable: raw.retryable } : {}),
      ...(Number.isFinite(raw.retry_after_ms) && raw.retry_after_ms >= 0 ? { retry_after_ms: raw.retry_after_ms } : {}),
    });
  }
  return {
    ok: status >= 200 && status < 300 && data.ok === true,
    results,
    ...(typeof data.complete === "boolean" ? { complete: data.complete } : {}),
    ...(typeof data.partial === "boolean" ? { partial: data.partial } : {}),
    ...(errors.length ? { errors } : {}),
    ...(Array.isArray(data.missing) ? { missing: data.missing.filter((hash): hash is string => typeof hash === "string") } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : status >= 400 ? { error: `HTTP ${status}` } : {}),
    retryable: typeof data.retryable === "boolean" ? data.retryable : [408, 425, 429, 500, 502, 503, 504].includes(status),
    ...(Number.isFinite(data.retry_after_ms) && Number(data.retry_after_ms) >= 0 ? { retry_after_ms: Number(data.retry_after_ms) } : {}),
    ...(data.aborted === true ? { aborted: true } : {}),
  };
}
