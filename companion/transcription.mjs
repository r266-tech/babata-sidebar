const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_SECONDS = 25;
const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"], ["video/webm", "webm"],
  ["audio/ogg", "ogg"], ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"], ["audio/mp3", "mp3"],
  ["audio/wav", "wav"], ["audio/x-wav", "wav"],
]);

function failure(status, message) {
  return Object.assign(new Error(message), { status, retryable: false });
}

export function transcriptionCapabilities(provider) {
  return {
    ok: true,
    available: Boolean(provider?.base_url && provider?.model),
    max_chunk_seconds: MAX_CHUNK_SECONDS,
    max_bytes: MAX_AUDIO_BYTES,
  };
}

/** Audio is forwarded in memory and never written to disk. Recording is an
 * explicit, page-side user action; this endpoint cannot start capture. */
export async function transcribeAudio(provider, payload, providerFetch, signal) {
  if (!transcriptionCapabilities(provider).available) {
    throw failure(503, "Configure an audio transcription provider in extension settings first");
  }
  if (!payload || typeof payload !== "object") throw failure(400, "Audio transcription payload required");
  const mime = typeof payload.mime === "string" ? payload.mime.split(";")[0].trim().toLowerCase() : "";
  const extension = AUDIO_TYPES.get(mime);
  if (!extension) throw failure(400, "Unsupported audio container");
  const duration = Number(payload.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CHUNK_SECONDS) {
    throw failure(400, `Audio chunks must be between 0 and ${MAX_CHUNK_SECONDS} seconds`);
  }
  const encoded = payload.audio_base64;
  if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
    throw failure(413, "Audio chunk exceeds 4 MiB");
  }
  const firstPadding = encoded.indexOf("=");
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)
    || (firstPadding !== -1 && (firstPadding < encoded.length - 2 || !/^={1,2}$/.test(encoded.slice(firstPadding))))) {
    throw failure(400, "Audio must be valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw failure(413, "Audio chunk exceeds 4 MiB");
  signal?.throwIfAborted();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), `audio.${extension}`);
  form.append("model", provider.model);
  const responseFormat = process.env.BABATA_TRANSCRIPTION_RESPONSE_FORMAT === "verbose_json" ? "verbose_json" : "json";
  form.append("response_format", responseFormat);
  if (typeof payload.source === "string" && /^[a-z]{2,3}$/i.test(payload.source)) form.append("language", payload.source.toLowerCase());
  const data = await providerFetch(provider, "audio/transcriptions", {
    method: "POST", body: form, signal, priority: "subtitle",
  });
  if (typeof data?.text !== "string") throw failure(502, "Transcription provider returned no text field");
  if (data.text.length > 20_000) throw failure(502, "Transcription response exceeds the chunk text limit");
  if (data.segments !== undefined && !Array.isArray(data.segments)) throw failure(502, "Transcription provider returned invalid segments");
  const rawSegments = data.segments || [];
  if (rawSegments.length > 200) throw failure(502, "Transcription response exceeds the chunk segment limit");
  let segmentChars = 0;
  for (const segment of rawSegments) {
    if (!segment || typeof segment.text !== "string") throw failure(502, "Transcription provider returned invalid segments");
    segmentChars += segment.text.length;
    if (segment.text.length > 12_000 || segmentChars > 20_000) throw failure(502, "Transcription response exceeds the chunk text limit");
  }
  const segments = rawSegments
    .filter((item) => item && typeof item.text === "string" && Number.isFinite(item.start) && Number.isFinite(item.end)
      && item.start >= 0 && item.end > item.start && item.start < duration + 1)
    .map((item) => ({ start: item.start, end: Math.min(item.end, duration + 1), text: item.text.trim() }))
    .filter((item) => item.text && item.end > item.start);
  return {
    ok: true,
    text: data.text.trim(),
    ...(typeof data.language === "string" ? { language: data.language.slice(0, 40) } : {}),
    ...(segments.length ? { segments } : {}),
  };
}
