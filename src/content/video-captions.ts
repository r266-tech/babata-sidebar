import { cleanCaptionText, type CaptionCue } from "./youtube-captions";

export interface CaptionSource {
  id: string;
  label: string;
  language: string;
  cues: CaptionCue[];
  track?: TextTrack;
}

interface PreparedCaptionSource {
  cues: CaptionCue[];
  language: string;
  key: string;
  endMs: number;
}

export interface CaptionSourceGroups {
  sources: CaptionSource[];
  aliases: Map<string, string>;
}

// Sources are replaced when their cues or metadata change. Keep comparisons
// tied to those revisions instead of scanning transcripts during playback.
const preparedSources = new WeakMap<CaptionSource, PreparedCaptionSource>();
const rollingMatches = new WeakMap<CaptionSource, WeakMap<CaptionSource, boolean>>();

function prepareCaptionSource(source: CaptionSource): PreparedCaptionSource {
  const previous = preparedSources.get(source);
  if (previous) return previous;
  const language = source.language.trim().toLowerCase().replace(/_/g, "-");
  const cues = source.cues.filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs)
    && cue.startMs >= 0 && cue.endMs > cue.startMs && typeof cue.text === "string")
    .map((cue) => ({ ...cue, text: cleanCaptionText(cue.text) })).filter((cue) => cue.text)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const prepared = { cues, language, key: captionTextKey(JSON.stringify(cues), "source", language), endMs: cues.reduce((end, cue) => Math.max(end, cue.endMs), 0) };
  preparedSources.set(source, prepared);
  return prepared;
}

function sameCaptionCues(left: PreparedCaptionSource, right: PreparedCaptionSource): boolean {
  return left.cues.length > 0 && left.language === right.language && left.cues.length === right.cues.length
    && left.cues.every((cue, index) => cue.startMs === right.cues[index].startMs
      && cue.endMs === right.cues[index].endMs && cue.text === right.cues[index].text);
}

function isInternalCopy(source: CaptionSource): boolean {
  return !!source.track && !source.language.trim() && /^(?:clone|copy)(?:[\s_-]*\d+)?$/i.test(source.label.trim());
}

function isRollingCopy(copy: CaptionSource, original: CaptionSource): boolean {
  let comparisons = rollingMatches.get(copy);
  if (!comparisons) { comparisons = new WeakMap(); rollingMatches.set(copy, comparisons); }
  const cached = comparisons.get(original);
  if (cached !== undefined) return cached;
  const result = matchesRollingCues(prepareCaptionSource(copy), prepareCaptionSource(original));
  comparisons.set(original, result);
  return result;
}

function matchesRollingCues(copy: PreparedCaptionSource, original: PreparedCaptionSource): boolean {
  const toleranceMs = 1;
  if (!copy.cues.length || !original.cues.length
    || Math.abs(copy.cues[0].startMs - original.cues[0].startMs) > toleranceMs
    || Math.abs(copy.endMs - original.endMs) > toleranceMs) return false;
  const covered = new Map<number, Array<{ startMs: number; endMs: number; canClipStart: boolean }>>();
  let next = 0;
  let active: number[] = [];
  for (const cue of copy.cues) {
    active = active.filter((index) => original.cues[index].endMs + toleranceMs >= cue.startMs);
    while (next < original.cues.length && original.cues[next].startMs <= cue.startMs + toleranceMs) {
      if (original.cues[next].endMs + toleranceMs >= cue.startMs) active.push(next);
      next += 1;
    }
    // A real rolling display has few simultaneous lines. Preserve unusual or
    // hostile tracks instead of allowing a quadratic transcript comparison.
    if (active.length > 32) return false;
    let match: number[] | undefined;
    for (const start of active) {
      let text = "";
      const indices: number[] = [];
      for (let index = start; index < original.cues.length && indices.length < 32; index += 1) {
        const part = original.cues[index];
        // A combined line must be displayed while all its original lines are
        // valid. Matching words somewhere else in the video are insufficient.
        if (part.startMs > cue.startMs + toleranceMs || part.endMs + toleranceMs < cue.endMs) break;
        text += `${text ? " " : ""}${part.text}`;
        indices.push(index);
        if (text === cue.text) {
          if (match) return false; // Repeated simultaneous phrases are ambiguous.
          match = indices;
          break;
        }
        if (!cue.text.startsWith(`${text} `)) break;
      }
    }
    if (!match) return false;
    for (const index of match) {
      const intervals = covered.get(index) ?? [];
      const canClipStart = match.some((other) => other !== index
        && original.cues[other].startMs > original.cues[index].startMs + toleranceMs
        && Math.abs(original.cues[other].startMs - cue.startMs) <= toleranceMs);
      intervals.push({ startMs: cue.startMs, endMs: cue.endMs, canClipStart });
      covered.set(index, intervals);
    }
  }
  if (covered.size !== original.cues.length) return false;
  for (const [index, intervals] of covered) {
    let endMs = original.cues[index].startMs;
    for (let at = 0; at < intervals.length; at += 1) {
      const interval = intervals[at];
      // Some players keep an older line only from the next line's arrival,
      // as part of their combined rolling cue. That precise leading clip is
      // allowed; arbitrary gaps, isolated clips, and missing tails are not.
      if (interval.startMs > endMs + toleranceMs && (at !== 0 || !interval.canClipStart)) return false;
      endMs = Math.max(endMs, interval.endMs);
    }
    if (endMs + toleranceMs < original.cues[index].endMs) return false;
  }
  return true;
}

/** Collapse equivalent native choices without deleting their live sources.
 * Imported files and transcription remain distinct, explicit user choices. */
export function groupCaptionSources(sources: CaptionSource[]): CaptionSourceGroups {
  const aliases = new Map(sources.map((source) => [source.id, source.id]));
  const native = sources.filter((source) => source.track);
  const buckets = new Map<string, CaptionSource[]>();
  // Prefer a descriptive track over a platform's internal copy when exact
  // duplicates have the same language, regardless of insertion order.
  for (const source of [...native].sort((a, b) => Number(isInternalCopy(a)) - Number(isInternalCopy(b)))) {
    const prepared = prepareCaptionSource(source);
    const bucket = buckets.get(prepared.key) ?? [];
    const duplicate = bucket.find((candidate) => sameCaptionCues(prepared, prepareCaptionSource(candidate)));
    if (duplicate) aliases.set(source.id, duplicate.id);
    else { bucket.push(source); buckets.set(prepared.key, bucket); }
  }
  const representatives = native.filter((source) => aliases.get(source.id) === source.id);
  const originals = representatives.filter((source) => source.language.trim() && !isInternalCopy(source));
  for (const source of representatives) {
    if (!isInternalCopy(source)) continue;
    const candidates = originals.filter((original) => isRollingCopy(source, original));
    // An unknown-language copy must never choose arbitrarily between real
    // language tracks, even when their short captions happen to match.
    if (candidates.length === 1) aliases.set(source.id, candidates[0].id);
  }
  for (const [id, candidate] of aliases) aliases.set(id, aliases.get(candidate) ?? candidate);
  const byId = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  const choices: CaptionSource[] = [];
  for (const source of sources) {
    const id = aliases.get(source.id)!;
    if (seen.has(id)) continue;
    seen.add(id);
    choices.push(byId.get(id)!);
  }
  return { sources: choices, aliases };
}

export function captionTextKey(text: string, target = "zh", language = ""): string {
  // The transport key is only an identifier. The companion builds its own
  // complete provider/prompt/language cache identity from the request.
  const input = `${target}\u0000${language}\u0000${text.replace(/\s+/g, " ").trim()}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    first = Math.imul(first ^ input.charCodeAt(i), 0x01000193);
    second = Math.imul(second ^ input.charCodeAt(i), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

export function normalizeCaptionCues(cues: CaptionCue[]): CaptionCue[] {
  const result: CaptionCue[] = [];
  const sorted = cues.filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs)
    && cue.startMs >= 0 && cue.endMs > cue.startMs && typeof cue.text === "string")
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (const cue of sorted.slice(0, 20_000)) {
    const text = cleanCaptionText(cue.text);
    if (!text || text.length > 12_000) continue;
    const last = result.at(-1);
    if (last?.text === text && cue.startMs <= last.endMs + 60) {
      last.endMs = Math.max(last.endMs, cue.endMs);
    } else result.push({ startMs: cue.startMs, endMs: cue.endMs, text });
  }
  return result;
}

/** Precompute overlap boundaries once. Lookup is O(log n), never a scan of an
 * entire transcript on every animation frame. Most recent overlapping cue wins,
 * matching rolling-caption replacement; an older cue resumes if still active. */
export class CaptionTimeline {
  readonly cues: CaptionCue[];
  private intervals: Array<{ start: number; end: number; index: number }> = [];

  constructor(input: CaptionCue[]) {
    this.cues = normalizeCaptionCues(input);
    const events = this.cues.flatMap((cue, index) => [
      { time: cue.startMs, index, add: true }, { time: cue.endMs, index, add: false },
    ]).sort((a, b) => a.time - b.time || Number(a.add) - Number(b.add));
    const active = new Set<number>();
    const heap: number[] = [];
    const push = (index: number) => {
      heap.push(index);
      let at = heap.length - 1;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (heap[parent] >= heap[at]) break;
        [heap[parent], heap[at]] = [heap[at], heap[parent]];
        at = parent;
      }
    };
    const pop = () => {
      const last = heap.pop();
      if (!heap.length || last === undefined) return;
      heap[0] = last;
      let at = 0;
      for (;;) {
        let child = at * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1] > heap[child]) child += 1;
        if (heap[at] >= heap[child]) break;
        [heap[at], heap[child]] = [heap[child], heap[at]];
        at = child;
      }
    };
    for (let at = 0; at < events.length;) {
      const start = events[at].time;
      while (at < events.length && events[at].time === start) {
        const event = events[at++];
        if (event.add) { active.add(event.index); push(event.index); }
        else active.delete(event.index);
      }
      while (heap.length && !active.has(heap[0])) pop();
      const end = events[at]?.time;
      if (!heap.length || end === undefined || end <= start) continue;
      const last = this.intervals.at(-1);
      if (last && last.index === heap[0] && last.end === start) last.end = end;
      else this.intervals.push({ start, end, index: heap[0] });
    }
  }

  indexAt(timeMs: number): number {
    let low = 0;
    let high = this.intervals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.intervals[middle].start <= timeMs) low = middle + 1;
      else high = middle;
    }
    const interval = this.intervals[low - 1];
    return interval && timeMs < interval.end ? interval.index : -1;
  }

  nextIndex(timeMs: number): number {
    let low = 0;
    let high = this.cues.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.cues[middle].startMs < timeMs) low = middle + 1;
      else high = middle;
    }
    return low < this.cues.length ? low : -1;
  }
}

export function cuesFromTextTrack(track: TextTrack): CaptionCue[] {
  if (!track.cues) return [];
  return Array.from(track.cues).slice(0, 20_000).flatMap((cue) => {
    const text = (cue as VTTCue).text;
    return typeof text === "string" ? [{ startMs: cue.startTime * 1000, endMs: cue.endTime * 1000, text }] : [];
  });
}
