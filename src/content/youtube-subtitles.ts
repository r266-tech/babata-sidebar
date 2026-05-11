/// <reference types="chrome" />

const BBT_YT_CAPTION_MESSAGE = "babata.youtube_caption_response";
const TARGET_LANG = "zh";
const MAX_CUES = 240;
const TRANSLATE_BATCH_SIZE = 24;

interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

interface YoutubeTimedTextEvent {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

interface YoutubeTimedTextResponse {
  events?: YoutubeTimedTextEvent[];
}

function normalizeForHash(text: string): string {
  return text
    .replace(/[\u200B-\u200F\uFEFF\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text: string, target: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  const s = text + "|" + target;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x100000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0")
    + (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

function cueText(event: YoutubeTimedTextEvent): string {
  return (event.segs || [])
    .map((seg) => seg.utf8 || "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson3(body: string): CaptionCue[] {
  let parsed: YoutubeTimedTextResponse;
  try {
    parsed = JSON.parse(body) as YoutubeTimedTextResponse;
  } catch {
    return [];
  }
  const cues: CaptionCue[] = [];
  for (const event of parsed.events || []) {
    const text = cueText(event);
    if (!text) continue;
    const startMs = event.tStartMs ?? 0;
    const duration = event.dDurationMs ?? 1800;
    cues.push({ startMs, endMs: startMs + duration, text });
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

function parseTimestamp(raw: string): number | null {
  const parts = raw.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secPart = parts.pop() || "0";
  const seconds = Number(secPart.replace(",", "."));
  const minutes = Number(parts.pop() || "0");
  const hours = Number(parts.pop() || "0");
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return null;
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

function parseVtt(body: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = body.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const startMs = parseTimestamp(startRaw);
    const endMs = parseTimestamp(endRaw);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = lines.slice(timeIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({ startMs, endMs, text });
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

function parseCaptionBody(body: string): CaptionCue[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) return parseJson3(trimmed);
  if (/^WEBVTT\b/.test(trimmed)) return parseVtt(trimmed);
  return [];
}

function shouldTranslateCue(text: string): boolean {
  return /[\p{L}]/u.test(text)
    && !/^[\d\s:.,，.%％+\-–—/()（）[\]万亿千百十kKmMbB]+$/u.test(text);
}

async function translateCues(cues: CaptionCue[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < cues.length; i += TRANSLATE_BATCH_SIZE) {
    const chunk = cues.slice(i, i + TRANSLATE_BATCH_SIZE)
      .filter((cue) => shouldTranslateCue(cue.text));
    if (chunk.length === 0) continue;
    const batch = chunk.map((cue) => {
      const normalized = normalizeForHash(cue.text);
      return {
        hash: hashText(normalized, TARGET_LANG),
        text: cue.text,
      };
    });
    let resp: { ok?: boolean; results?: Array<{ hash: string; translated: string }> } | undefined;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "babata.translate",
        site: location.hostname,
        url: location.href,
        target: TARGET_LANG,
        batch,
      }) as { ok?: boolean; results?: Array<{ hash: string; translated: string }> } | undefined;
    } catch {
      continue;
    }
    if (!resp?.ok || !Array.isArray(resp.results)) continue;
    for (const result of resp.results) {
      if (result.hash && result.translated) out.set(result.hash, result.translated.trim());
    }
  }
  return out;
}

function activeVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  return videos.find((video) => !video.paused && video.readyState > 0) || videos[0] || null;
}

function clearTrack(track: TextTrack) {
  const cues = track.cues ? Array.from(track.cues) : [];
  for (const cue of cues) {
    try {
      track.removeCue(cue);
    } catch {
      /* cue may have been detached by the player */
    }
  }
}

function installCueTrack(cues: CaptionCue[], translations: Map<string, string>) {
  const video = activeVideo();
  if (!video || typeof VTTCue === "undefined") return;
  let track = Array.from(video.textTracks)
    .find((candidate) => candidate.label === "babata");
  if (!track) {
    track = video.addTextTrack("subtitles", "babata", TARGET_LANG);
  }
  clearTrack(track);
  for (const cue of cues) {
    const hash = hashText(normalizeForHash(cue.text), TARGET_LANG);
    const translated = translations.get(hash);
    if (!translated) continue;
    const merged = `${cue.text}\n${translated}`;
    try {
      track.addCue(new VTTCue(cue.startMs / 1000, cue.endMs / 1000, merged));
    } catch {
      /* bad cue timing from upstream captions */
    }
  }
  track.mode = "showing";
}

const processedUrls = new Set<string>();
let processingSeq = 0;

async function processCaptionResponse(url: string, body: string) {
  if (processedUrls.has(url)) return;
  processedUrls.add(url);
  if (processedUrls.size > 20) {
    const first = processedUrls.values().next().value as string | undefined;
    if (first) processedUrls.delete(first);
  }
  const cues = parseCaptionBody(body);
  if (cues.length === 0) return;
  const seq = ++processingSeq;
  const translations = await translateCues(cues);
  if (seq !== processingSeq || translations.size === 0) return;
  installCueTrack(cues, translations);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as {
    source?: string;
    type?: string;
    url?: string;
    response?: string;
  };
  if (data?.source !== "babata-youtube-subtitles-main") return;
  if (data.type !== BBT_YT_CAPTION_MESSAGE) return;
  if (!data.url || !data.response) return;
  void processCaptionResponse(data.url, data.response);
});

export {};
