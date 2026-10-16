import { cleanCaptionText, type CaptionCue } from "./youtube-captions";

export interface CaptionSource {
  id: string;
  label: string;
  language: string;
  cues: CaptionCue[];
  track?: TextTrack;
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
