const MAX_CUES = 20_000;
const MAX_CUE_TEXT = 12_000;

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

interface YoutubeTimedTextEvent {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
  aAppend?: number;
  wWinId?: number;
}

interface YoutubeTimedTextResponse {
  events?: YoutubeTimedTextEvent[];
}

function decodeCaptionEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? raw;
    const point = Number.parseInt(entity.slice(entity[1]?.toLowerCase() === "x" ? 2 : 1), entity[1]?.toLowerCase() === "x" ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
  });
}

function cleanCaptionLine(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/gi, ">")
    .replace(/^\s*(?:>{2,}|›{2,}|»+)\s*/u, "")
    .trim();
}

export function cleanCaptionText(text: string): string {
  return decodeCaptionEntities(text
    .split(/\r?\n/)
    .map((line) => cleanCaptionLine(line))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim());
}

function cueText(event: YoutubeTimedTextEvent): string {
  return cleanCaptionText((event.segs || [])
    .map((seg) => seg.utf8 || "")
    .join(""));
}

function parseJson3(body: string): CaptionCue[] {
  let parsed: YoutubeTimedTextResponse;
  try {
    parsed = JSON.parse(body) as YoutubeTimedTextResponse;
  } catch {
    return [];
  }
  const cues: CaptionCue[] = [];
  const windows = new Map<number, CaptionCue>();
  if (!parsed || !Array.isArray(parsed.events)) return [];
  for (const event of parsed.events) {
    if (!event || !Array.isArray(event.segs)) continue;
    if (!event.segs.every((seg) => seg && (seg.utf8 === undefined || typeof seg.utf8 === "string"))) continue;
    const text = cueText(event);
    if (!text || text.length > MAX_CUE_TEXT) continue;
    const startMs = event.tStartMs ?? 0;
    const duration = event.dDurationMs ?? 1800;
    if (!Number.isFinite(startMs) || !Number.isFinite(duration) || !Number.isFinite(startMs + duration) || startMs < 0 || duration <= 0) continue;
    const previous = windows.get(event.wWinId ?? 0);
    // JSON3 append events extend a displayed phrase, not a new duplicate line.
    // Bound merging so a live rolling window cannot grow without limit.
    if (event.aAppend === 1 && previous && startMs <= previous.endMs + 300
      && startMs + duration - previous.startMs <= 8000 && previous.text.length + text.length < 320) {
      previous.text = `${previous.text} ${text}`.trim();
      previous.endMs = Math.max(previous.endMs, startMs + duration);
    } else {
      const cue = { startMs, endMs: startMs + duration, text };
      cues.push(cue);
      windows.set(event.wWinId ?? 0, cue);
    }
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^(?:\d+:)?[0-5]?\d:[0-5]\d(?:[.,]\d{1,3})?$/.test(raw.trim())) return null;
  const parts = raw.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secPart = parts.pop() || "0";
  const seconds = Number(secPart.replace(",", "."));
  const minutes = Number(parts.pop() || "0");
  const hours = Number(parts.pop() || "0");
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return null;
  const timestamp = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseVtt(body: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const blocks = body.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] ?? "")) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const startMs = parseTimestamp(startRaw);
    const endMs = parseTimestamp(endRaw);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = cleanCaptionText(lines.slice(timeIndex + 1).join("\n"));
    if (!text || text.length > MAX_CUE_TEXT) continue;
    cues.push({ startMs, endMs, text });
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

export function parseCaptionBody(body: string): CaptionCue[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) return parseJson3(trimmed);
  if (/^WEBVTT\b/.test(trimmed) || /^\d+\s*\r?\n\d{1,3}:\d{2}/.test(trimmed)) return parseVtt(trimmed);
  return [];
}
