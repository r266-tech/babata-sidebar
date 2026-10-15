/// <reference types="chrome" />
import {
  STORAGE_TRANSLATION_MODE, STORAGE_ALWAYS_TRANSLATE_HOSTS, STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
  effectiveTranslationModeForHost,
} from "../translation-settings";

import { parseCaptionBody, type CaptionCue } from "./youtube-captions";

const BBT_YT_CAPTION_MESSAGE = "babata.youtube_caption_response";
const TARGET_LANG = "zh";
const TRANSLATE_BATCH_SIZE = 24;
const TRANSLATE_WINDOW_BEFORE = 4;
const TRANSLATE_WINDOW_AFTER = 24;
const TRANSLATE_WINDOW_THROTTLE_MS = 900;
const TRANSLATE_MAX_ATTEMPTS = 4;
const TRANSLATE_RETRY_BASE_MS = 1500;
const TRANSLATE_MAX_CONCURRENT = 2;
const OVERLAY_ID = "bbt-youtube-subtitle-overlay";
const STYLE_ID = "bbt-youtube-subtitle-style";
const PLAYER_ACTIVE_CLASS = "bbt-youtube-subtitle-active";

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

function shouldTranslateCue(text: string): boolean {
  return /[\p{L}]/u.test(text)
    && !/^[\d\s:.,，.%％+\-–—/()（）[\]万亿千百十kKmMbB]+$/u.test(text);
}

async function translateCues(cues: CaptionCue[], sequence: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < cues.length;) {
    if (!subtitlesEnabled || sequence !== processingSeq) break;
    const chunk: CaptionCue[] = [];
    let chars = 0;
    while (i < cues.length && chunk.length < TRANSLATE_BATCH_SIZE) {
      const cue = cues[i];
      if (chunk.length && chars + cue.text.length > 12_000) break;
      i += 1;
      if (!shouldTranslateCue(cue.text)) continue;
      chunk.push(cue);
      chars += cue.text.length;
    }
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
    const expectedHashes = new Set(batch.map((item) => item.hash));
    for (const result of resp.results) {
      if (result && expectedHashes.has(result.hash) && typeof result.translated === "string" && result.translated.trim()) {
        out.set(result.hash, result.translated.trim());
      }
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

function disableNativeBabataTrack(video: HTMLVideoElement) {
  for (const track of Array.from(video.textTracks)) {
    if (track.label !== "babata") continue;
    clearTrack(track);
    track.mode = "disabled";
  }
}

function ensureOverlayStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${PLAYER_ACTIVE_CLASS} .ytp-caption-window-container {
      display: none !important;
    }

    #${OVERLAY_ID} {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 9%;
      z-index: 2147483647;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      box-sizing: border-box;
      padding: 0 4%;
      pointer-events: none;
      text-align: center;
      font-family: Roboto, Arial, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
    }

    #${OVERLAY_ID} .bbt-yt-subtitle-line {
      box-sizing: border-box;
      width: max-content;
      max-width: 92%;
      padding: 2px 10px 4px;
      border-radius: 1px;
      background: rgba(0, 0, 0, 0.72);
      color: #fff;
      font-size: clamp(20px, 3vw, 46px);
      font-weight: 400;
      line-height: 1.22;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  `;
  document.documentElement.appendChild(style);
}

function activePlayer(video: HTMLVideoElement): HTMLElement {
  return video.closest<HTMLElement>(".html5-video-player")
    || video.parentElement
    || document.body;
}

let overlayEl: HTMLDivElement | null = null;
let overlayOriginalEl: HTMLDivElement | null = null;
let overlayTranslationEl: HTMLDivElement | null = null;
let overlayPlayer: HTMLElement | null = null;
let activeCaptionCues: CaptionCue[] = [];
let activeTranslations = new Map<string, string>();
let inFlightTranslationHashes = new Set<string>();
let translationRetries = new Map<string, { attempts: number; nextAt: number }>();
let activeTranslationWindows = 0;
let currentOverlayKey = "";
let renderFrame = 0;
let lastTranslationWindowKey = "";
let lastTranslationWindowAt = 0;
let subtitlesEnabled = false;
let pageSuspended = false;
let navigating = false;
let videoKey = currentVideoKey();
let settingsSequence = 0;

function currentVideoKey(): string {
  const url = new URL(location.href);
  return url.searchParams.get("v") || url.pathname;
}

function cueHash(cue: CaptionCue): string {
  return hashText(normalizeForHash(cue.text), TARGET_LANG);
}

function cueTranslation(cue: CaptionCue): string | undefined {
  return activeTranslations.get(cueHash(cue));
}

function ensureOverlay(video: HTMLVideoElement): HTMLDivElement {
  ensureOverlayStyle();
  const player = activePlayer(video);
  if (overlayEl?.isConnected && overlayPlayer === player) return overlayEl;

  if (overlayPlayer && overlayPlayer !== player) {
    overlayPlayer.classList.remove(PLAYER_ACTIVE_CLASS);
  }
  overlayEl?.remove();

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  if (getComputedStyle(player).position === "static") {
    player.style.position = "relative";
  }

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "notranslate";
  overlay.dataset.bbtYoutubeSubtitles = "1";
  overlay.setAttribute("translate", "no");

  const original = document.createElement("div");
  original.className = "bbt-yt-subtitle-line bbt-yt-subtitle-original";

  const translation = document.createElement("div");
  translation.className = "bbt-yt-subtitle-line bbt-yt-subtitle-translation";

  overlay.append(original, translation);
  player.appendChild(overlay);

  overlayEl = overlay;
  overlayOriginalEl = original;
  overlayTranslationEl = translation;
  overlayPlayer = player;
  return overlay;
}

function findActiveCueIndex(currentMs: number): number {
  let best = -1;
  for (let i = 0; i < activeCaptionCues.length; i += 1) {
    const cue = activeCaptionCues[i];
    if (cue.startMs > currentMs + 120) break;
    if (currentMs >= cue.startMs - 120 && currentMs <= cue.endMs + 120) {
      best = i;
    }
  }
  return best;
}

function hideOverlay() {
  currentOverlayKey = "";
  if (overlayEl) overlayEl.style.display = "none";
  overlayPlayer?.classList.remove(PLAYER_ACTIVE_CLASS);
}

function scheduleCueWindowTranslation(centerIndex: number) {
  if (!subtitlesEnabled || pageSuspended || centerIndex < 0 || activeCaptionCues.length === 0) return;
  if (activeTranslationWindows >= TRANSLATE_MAX_CONCURRENT) return;
  const start = Math.max(0, centerIndex - TRANSLATE_WINDOW_BEFORE);
  const end = Math.min(activeCaptionCues.length, centerIndex + TRANSLATE_WINDOW_AFTER);
  const now = Date.now();
  const key = `${start}:${end}`;
  if (key === lastTranslationWindowKey && now - lastTranslationWindowAt < TRANSLATE_WINDOW_THROTTLE_MS) {
    return;
  }
  lastTranslationWindowKey = key;
  lastTranslationWindowAt = now;

  const missing: CaptionCue[] = [];
  for (let i = start; i < end; i += 1) {
    const cue = activeCaptionCues[i];
    if (!shouldTranslateCue(cue.text)) continue;
    const hash = cueHash(cue);
    if (activeTranslations.has(hash) || inFlightTranslationHashes.has(hash)) continue;
    const retry = translationRetries.get(hash);
    if (retry && (retry.attempts >= TRANSLATE_MAX_ATTEMPTS || retry.nextAt > now)) continue;
    inFlightTranslationHashes.add(hash);
    missing.push(cue);
  }
  if (missing.length === 0) return;
  const seq = processingSeq;
  activeTranslationWindows += 1;
  void translateCueWindow(missing, seq);
}

async function translateCueWindow(cues: CaptionCue[], seq: number) {
  const translations = await translateCues(cues, seq);
  if (seq !== processingSeq) return;
  activeTranslationWindows -= 1;
  for (const cue of cues) {
    const hash = cueHash(cue);
    inFlightTranslationHashes.delete(hash);
    if (translations.has(hash)) translationRetries.delete(hash);
    else {
      const attempts = (translationRetries.get(hash)?.attempts ?? 0) + 1;
      translationRetries.set(hash, {
        attempts,
        nextAt: Date.now() + TRANSLATE_RETRY_BASE_MS * 2 ** (attempts - 1),
      });
    }
  }
  if (seq !== processingSeq || translations.size === 0) return;
  for (const [hash, translated] of translations) {
    activeTranslations.set(hash, translated);
  }
}

function renderSubtitleOverlay() {
  renderFrame = 0;
  if (!subtitlesEnabled || pageSuspended || activeCaptionCues.length === 0) { hideOverlay(); return; }
  if (currentVideoKey() !== videoKey) { resetCaptions(); return; }
  const video = activeVideo();
  if (!video || activeCaptionCues.length === 0) {
    hideOverlay();
    renderFrame = requestAnimationFrame(renderSubtitleOverlay);
    return;
  }

  disableNativeBabataTrack(video);
  const overlay = ensureOverlay(video);
  const cueIndex = findActiveCueIndex(video.currentTime * 1000);
  if (cueIndex >= 0) scheduleCueWindowTranslation(cueIndex);
  const cue = cueIndex >= 0 ? activeCaptionCues[cueIndex] : null;
  const translated = cue ? cueTranslation(cue) : undefined;
  if (!cue || !translated) {
    hideOverlay();
    renderFrame = requestAnimationFrame(renderSubtitleOverlay);
    return;
  }

  const key = `${cueIndex}:${cue.text}:${translated}`;
  if (key !== currentOverlayKey) {
    currentOverlayKey = key;
    if (overlayOriginalEl) overlayOriginalEl.textContent = cue.text;
    if (overlayTranslationEl) overlayTranslationEl.textContent = translated;
  }
  overlay.style.display = "flex";
  overlayPlayer?.classList.add(PLAYER_ACTIVE_CLASS);
  renderFrame = requestAnimationFrame(renderSubtitleOverlay);
}

function installSubtitleOverlay(cues: CaptionCue[]) {
  activeCaptionCues = cues;
  activeTranslations = new Map();
  inFlightTranslationHashes = new Set();
  translationRetries.clear();
  activeTranslationWindows = 0;
  currentOverlayKey = "";
  lastTranslationWindowKey = "";
  lastTranslationWindowAt = 0;
  const video = activeVideo();
  if (video) {
    disableNativeBabataTrack(video);
    ensureOverlay(video);
    const cueIndex = findActiveCueIndex(video.currentTime * 1000);
    scheduleCueWindowTranslation(cueIndex >= 0 ? cueIndex : 0);
  }
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(renderSubtitleOverlay);
}

const processedUrls = new Map<string, string>();
let processingSeq = 0;

async function processCaptionResponse(url: string, body: string) {
  if (navigating || pageSuspended || body.length > 2_000_000) return;
  let requestedVideo: string | null;
  try {
    const caption = new URL(url, location.href);
    if (!caption.pathname.endsWith("/api/timedtext")) return;
    requestedVideo = caption.searchParams.get("v");
  } catch { return; }
  if (currentVideoKey() !== videoKey) resetCaptions();
  if (requestedVideo && requestedVideo !== currentVideoKey()) return;
  const bodyHash = hashText(body, "caption");
  if (processedUrls.get(url) === bodyHash) return;
  const cues = parseCaptionBody(body);
  if (cues.length === 0) return;
  processedUrls.set(url, bodyHash);
  if (processedUrls.size > 20) {
    const first = processedUrls.keys().next().value as string | undefined;
    if (first) processedUrls.delete(first);
  }
  ++processingSeq;
  installSubtitleOverlay(cues);
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
  if (data.type === "babata.youtube_caption_ready") { requestLastCaption(); return; }
  if (data.type !== BBT_YT_CAPTION_MESSAGE) return;
  if (typeof data.url !== "string" || typeof data.response !== "string") return;
  void processCaptionResponse(data.url, data.response);
});

function requestLastCaption() {
  window.postMessage({ source: "babata-youtube-subtitles", type: "babata.youtube_caption_request" }, "*");
}
requestLastCaption();

function resetCaptions() {
  processingSeq += 1;
  videoKey = currentVideoKey();
  activeCaptionCues = [];
  activeTranslations.clear();
  inFlightTranslationHashes.clear();
  translationRetries.clear();
  activeTranslationWindows = 0;
  processedUrls.clear();
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  hideOverlay();
}

async function refreshEnabled() {
  const sequence = ++settingsSequence;
  try {
    const settings = await chrome.storage.local.get([
      STORAGE_TRANSLATION_MODE, STORAGE_ALWAYS_TRANSLATE_HOSTS, STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS,
    ]);
    if (sequence !== settingsSequence) return;
    const wasEnabled = subtitlesEnabled;
    subtitlesEnabled = effectiveTranslationModeForHost(
      settings[STORAGE_TRANSLATION_MODE], settings[STORAGE_ALWAYS_TRANSLATE_HOSTS], location.hostname,
      settings[STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS],
    ) !== "off";
    if (!subtitlesEnabled) hideOverlay();
    if (subtitlesEnabled && !wasEnabled) translationRetries.clear();
    if (!renderFrame && subtitlesEnabled && !pageSuspended && activeCaptionCues.length) {
      renderFrame = requestAnimationFrame(renderSubtitleOverlay);
    }
  } catch {
    if (sequence === settingsSequence) { subtitlesEnabled = false; hideOverlay(); }
  }
}

document.addEventListener("yt-navigate-start", () => { navigating = true; resetCaptions(); });
document.addEventListener("yt-navigate-finish", () => {
  navigating = false;
  if (videoKey !== currentVideoKey()) resetCaptions();
  requestLastCaption();
});
window.addEventListener("popstate", () => resetCaptions());
window.addEventListener("pagehide", () => { pageSuspended = true; resetCaptions(); });
window.addEventListener("pageshow", () => { pageSuspended = false; requestLastCaption(); void refreshEnabled(); });
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refreshEnabled(); });
void refreshEnabled();

export {};
