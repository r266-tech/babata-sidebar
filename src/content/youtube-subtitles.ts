/// <reference types="chrome" />
import {
  STORAGE_TRANSLATION_MODE, STORAGE_VIDEO_TRANSLATION,
  isVideoTranslationEnabled, normalizeTranslationRenderMode, type TranslationMode,
} from "../translation-settings";
import { requestTranslation } from "./translation-client";
import { parseCaptionBody, type CaptionCue } from "./youtube-captions";
import { captionTextKey, cuesFromTextTrack, groupCaptionSources, type CaptionSource } from "./video-captions";
import { SubtitleTranslationScheduler } from "./video-translation-scheduler";
import { VideoTranscription } from "./video-asr";

const videoWindow = window as Window & { __babataVideoTranslateBooted?: boolean };
if (!videoWindow.__babataVideoTranslateBooted) bootVideoTranslation();

function bootVideoTranslation(): void {
if (document.documentElement?.getAttribute("data-bbt-video-translate-version") !== "2"
  && document.querySelector('bbt-video-controls[data-bbt-video],.bbt-video-overlay[data-bbt-youtube-subtitles="1"],#bbt-youtube-subtitle-overlay[data-bbt-youtube-subtitles="1"]')) return;
const TEARDOWN_EVENT = "babata:video-translate-teardown";
document.dispatchEvent(new Event(TEARDOWN_EVENT));
videoWindow.__babataVideoTranslateBooted = true;
let destroyed = false;
const cleanups: Array<() => void> = [];
function listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): void {
  target.addEventListener(type, listener, options);
  cleanups.push(() => target.removeEventListener(type, listener, options));
}

const FONT_KEY = "babata.subtitle_font_scale";
const DEFAULT_STATUS = "开启网站字幕、导入字幕，或使用听译。";
const DISABLED_STATUS = "视频翻译已全局关闭，可在浮窗“翻译设置”中重新开启。";
const OVERLAY_ID = "bbt-youtube-subtitle-overlay";
const ACTIVE_CLASS = "bbt-youtube-subtitle-active";
const controllers = new Map<HTMLVideoElement, VideoSubtitleController>();
const trackIds = new WeakMap<TextTrack, number>();
let nextTrack = 1;
let nextController = 1;
let globalMode: TranslationMode = "replace";
// Do not dispatch before the initial stored policy is known.
let globalVideoEnabled = false;
let fontScale = 1;
let suspended = false;
let navigating = false;
let settingsSequence = 0;
let pageKey = currentPageKey();

function currentPageKey(): string {
  const url = new URL(location.href);
  return /(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname)
    ? url.searchParams.get("v") || url.pathname : `${url.pathname}${url.search}`;
}

function trackId(track: TextTrack): string {
  if (!trackIds.has(track)) trackIds.set(track, nextTrack++);
  return `track:${trackIds.get(track)}`;
}

function playerFor(video: HTMLVideoElement): HTMLElement {
  return video.closest<HTMLElement>(".html5-video-player") || video.parentElement || document.body;
}

function installStyles(): void {
  if (document.getElementById("bbt-youtube-subtitle-style")) return;
  const style = document.createElement("style");
  style.id = "bbt-youtube-subtitle-style";
  style.textContent = `
    .${ACTIVE_CLASS} .ytp-caption-window-container { visibility:hidden!important; }
    .bbt-video-overlay { position:absolute!important;left:var(--bbt-overlay-left,0px)!important;right:auto!important;
      width:var(--bbt-overlay-width,100%)!important;bottom:var(--bbt-overlay-bottom,11%)!important;
      z-index:2147483645!important;display:none;flex-direction:column;align-items:center;gap:4px;
      box-sizing:border-box!important;padding:0 3%!important;pointer-events:none!important;text-align:center!important;
      font-family:Arial,"Noto Sans CJK SC","Microsoft YaHei",sans-serif!important;
      text-shadow:0 1px 2px #000!important;transform:translateZ(0); }
    .bbt-video-overlay .bbt-yt-subtitle-line { box-sizing:border-box!important;width:max-content!important;max-width:94%!important;
      margin:0!important;padding:3px 9px!important;border-radius:4px!important;background:rgba(0,0,0,.78)!important;
      color:white!important;font-size:calc(clamp(18px,2.5vw,36px) * var(--bbt-subtitle-scale,1))!important;
      font-weight:500!important;line-height:1.3!important;white-space:pre-line!important;overflow-wrap:anywhere!important; }
    .bbt-video-overlay .bbt-yt-subtitle-original { font-size:calc(clamp(15px,2vw,27px) * var(--bbt-subtitle-scale,1))!important; }
    .bbt-video-overlay [hidden] { display:none!important; }
    bbt-video-controls { position:absolute!important;right:auto!important;left:var(--bbt-controls-left,10px)!important;
      top:var(--bbt-controls-top,10px)!important;transform:translateX(-100%)!important;z-index:2147483646!important;
      display:block!important;width:max-content!important;height:auto!important;font-size:14px!important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

class VideoSubtitleController {
  readonly id = nextController++;
  readonly sources = new Map<string, CaptionSource>();
  private scheduler: SubtitleTranslationScheduler;
  private asr: VideoTranscription;
  private player: HTMLElement;
  private overlay: HTMLDivElement;
  private original: HTMLDivElement;
  private translation: HTMLDivElement;
  private controls: HTMLElement;
  private modeButton: HTMLButtonElement;
  private modeSelect: HTMLSelectElement;
  private sourceSelect: HTMLSelectElement;
  private scaleInput: HTMLInputElement;
  private status: HTMLElement;
  private asrButton: HTMLButtonElement;
  private importButton: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  private asrStarting = false;
  private asrStartSequence = 0;
  private interactionGeneration = 0;
  private sourceId = "";
  private sourceAliases = new Map<string, string>();
  private sourceOptions: CaptionSource[] = [];
  private sourcesDirty = true;
  private mode: TranslationMode = globalVideoEnabled ? globalMode : "off";
  private manualMode: TranslationMode | undefined;
  private frame = 0;
  private videoFrame = 0;
  private renderQueued = false;
  private lastRender = "";
  private lastSchedule = "";
  private lastScheduledAt = 0;
  private seeking = false;
  private disposed = false;
  private previousPosition: string | undefined;
  private savedTrackModes = new Map<TextTrack, TextTrackMode>();
  private watchedTracks = new Map<TextTrack, () => void>();
  private trackSnapshots = new Map<TextTrack, string>();
  private cueSnapshots = new WeakMap<TextTrackCue, string>();
  private sourceSignature = "";
  private selectedSource: CaptionSource | undefined;
  private mediaKey: string;
  private asrCues: CaptionCue[] = [];
  private asrDelayMs = 0;
  private resizeObserver: ResizeObserver;
  private visibilityObserver: IntersectionObserver;
  private visible = false;
  private fullscreenTrack: TextTrack | undefined;
  private fullscreenKey = "";

  constructor(readonly video: HTMLVideoElement) {
    installStyles();
    this.player = playerFor(video);
    this.mediaKey = video.currentSrc || video.getAttribute("src") || "";
    this.scheduler = new SubtitleTranslationScheduler(
      (batch, signal) => requestTranslation({ batch, target: "zh", site: location.hostname, url: location.href, priority: "subtitle" }, { signal }),
      (error) => { if (error) this.setStatus(error); this.queueRender(); },
    );
    this.scheduler.enabled = this.mode !== "off";
    this.asr = new VideoTranscription(video, (cues, language, chunkStart) => {
      if (!globalVideoEnabled || this.disposed) return;
      this.asrCues = [...this.asrCues, ...cues].filter((cue) => cue.endMs >= this.video.currentTime * 1000 - 5 * 60_000);
      this.asrDelayMs = Math.max(this.asrDelayMs, this.video.currentTime * 1000 - chunkStart + 100);
      this.installSource({ id: "asr", label: "实时听译（有延迟）", language, cues: this.asrCues }, true);
      this.setStatus(`正在听译 · 约 ${Math.ceil(this.asrDelayMs / 1000)} 秒延迟`);
    }, (message, active) => {
      this.asrButton.textContent = active ? "停止听译" : "听译（无字幕）";
      this.setStatus(message);
    });
    this.overlay = document.createElement("div");
    this.overlay.id = document.getElementById(OVERLAY_ID) ? `${OVERLAY_ID}-${this.id}` : OVERLAY_ID;
    this.overlay.className = "bbt-video-overlay notranslate";
    this.overlay.setAttribute("translate", "no");
    this.overlay.dataset.bbtYoutubeSubtitles = "1";
    this.original = document.createElement("div");
    this.original.className = "bbt-yt-subtitle-line bbt-yt-subtitle-original";
    this.translation = document.createElement("div");
    this.translation.className = "bbt-yt-subtitle-line bbt-yt-subtitle-translation";
    this.overlay.append(this.original, this.translation);
    this.controls = document.createElement("bbt-video-controls");
    this.controls.className = "notranslate";
    this.controls.setAttribute("translate", "no");
    this.controls.dataset.bbtVideo = String(this.id);
    const shadow = this.controls.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{font:13px/1.4 system-ui,sans-serif;color:#fff;color-scheme:dark;}
      *{box-sizing:border-box}button,select,input{font:inherit}button,select{color:#fff;background:#20252e;border:1px solid #ffffff38;border-radius:7px;padding:6px 9px;cursor:pointer}
      button:hover,select:hover{background:#343c49}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #8bc5ff;outline-offset:2px}
      button:disabled,select:disabled,input:disabled{opacity:.5;cursor:not-allowed}
      .toolbar{display:flex;gap:3px;justify-content:flex-end;white-space:nowrap}.toggle{background:#18222ee6;opacity:.85}.toggle:hover{opacity:1}
      .panel{position:absolute;right:0;top:37px;width:248px;padding:12px;border:1px solid #ffffff24;border-radius:11px;background:#151a22f5;box-shadow:0 8px 25px #0005}
      .panel[hidden]{display:none}label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 9px}select{max-width:155px;min-width:100px}input[type=range]{width:145px}
      .actions{display:flex;flex-wrap:wrap;gap:6px}.status{margin:10px 0 0;color:#c2ccd8;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.file{display:none}
    </style><div class="toolbar"><button class="toggle" type="button"></button><button class="settings" type="button" aria-label="字幕设置" aria-expanded="false">⋯</button></div>
    <div class="panel" hidden><label>显示<select class="mode" aria-label="字幕显示模式"><option value="off">原生字幕</option><option value="replace">译文</option><option value="bilingual">双语</option></select></label>
    <label>字幕轨道<select class="source" aria-label="字幕轨道"><option value="">等待网站字幕</option></select></label>
    <label>字号<input class="scale" type="range" min="0.7" max="1.6" step="0.1" aria-label="字幕字号"></label>
    <div class="actions"><button class="import" type="button">导入字幕</button><button class="asr" type="button">听译（无字幕）</button></div>
    <input class="file" type="file" accept=".vtt,.srt,.json3" aria-label="选择字幕文件"><p class="status" role="status">开启网站字幕、导入字幕，或使用听译。</p></div>`;
    this.modeButton = shadow.querySelector<HTMLButtonElement>(".toggle")!;
    this.modeSelect = shadow.querySelector<HTMLSelectElement>(".mode")!;
    this.sourceSelect = shadow.querySelector<HTMLSelectElement>(".source")!;
    this.scaleInput = shadow.querySelector<HTMLInputElement>(".scale")!;
    this.status = shadow.querySelector<HTMLElement>(".status")!;
    this.asrButton = shadow.querySelector<HTMLButtonElement>(".asr")!;
    this.importButton = shadow.querySelector<HTMLButtonElement>(".import")!;
    this.fileInput = shadow.querySelector<HTMLInputElement>(".file")!;
    const settings = shadow.querySelector<HTMLButtonElement>(".settings")!;
    const panel = shadow.querySelector<HTMLElement>(".panel")!;
    settings.onclick = () => { panel.hidden = !panel.hidden; settings.setAttribute("aria-expanded", String(!panel.hidden)); };
    shadow.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") { panel.hidden = true; settings.setAttribute("aria-expanded", "false"); settings.focus(); } });
    // Keep controls from triggering a site's player click/keyboard shortcuts.
    for (const type of ["click", "dblclick", "pointerdown", "keydown"]) shadow.addEventListener(type, (event) => event.stopPropagation());
    this.modeButton.onclick = () => this.chooseMode(this.mode === "off" ? "replace" : this.mode === "replace" ? "bilingual" : "off");
    this.modeSelect.onchange = () => this.chooseMode(this.modeSelect.value as TranslationMode);
    this.sourceSelect.onchange = () => {
      if (!globalVideoEnabled || this.disposed) return;
      const source = this.sources.get(this.sourceSelect.value);
      if (source && this.sourceAliases.get(this.sourceId) !== source.id) this.selectSource(source);
    };
    this.scaleInput.oninput = () => {
      const scale = Number(this.scaleInput.value);
      fontScale = scale;
      for (const controller of controllers.values()) controller.setScale(scale);
      void chrome.storage.local.set({ [FONT_KEY]: scale });
    };
    const file = this.fileInput;
    this.importButton.onclick = () => { if (globalVideoEnabled && !this.disposed) file.click(); };
    file.onchange = async () => {
      if (!globalVideoEnabled || this.disposed) return;
      const selected = file.files?.[0];
      if (!selected) return;
      file.value = "";
      if (selected.size > 2_000_000) { this.setStatus("字幕文件不能超过 2 MB。"); return; }
      const generation = this.interactionGeneration;
      const cues = parseCaptionBody(await selected.text());
      if (!globalVideoEnabled || this.disposed || generation !== this.interactionGeneration) return;
      if (!cues.length) { this.setStatus("未识别到有效的 VTT、SRT 或 JSON3 字幕。"); return; }
      this.installSource({ id: `file:${selected.name}`, label: selected.name, language: "", cues }, true);
      if (this.mode === "off") this.chooseMode("replace");
      this.setStatus(`已载入 ${cues.length} 条字幕。`);
    };
    this.asrButton.onclick = async (event) => {
      if (!globalVideoEnabled || this.disposed || suspended) return;
      if (this.asr.active) { this.stopAsr("已停止听译。"); return; }
      if (this.asrStarting) return;
      if (!event.isTrusted) { this.setStatus("请亲自点击“听译”以授权采集此视频的音轨。"); return; }
      const sequence = ++this.asrStartSequence;
      this.asrStarting = true;
      this.asrButton.disabled = true;
      try {
        await this.asr.start();
        if (!globalVideoEnabled || this.disposed || sequence !== this.asrStartSequence || !this.asr.active) return;
        if (this.mode === "off") this.chooseMode("replace");
      } catch (error) {
        if (sequence === this.asrStartSequence) this.setStatus(error instanceof Error ? error.message : "无法启动听译。");
      } finally {
        if (sequence === this.asrStartSequence) {
          this.asrStarting = false;
          this.asrButton.disabled = !globalVideoEnabled;
        }
      }
    };
    this.resizeObserver = new ResizeObserver(() => { this.updateLayout(); this.refreshVisibility(); });
    this.resizeObserver.observe(video);
    this.resizeObserver.observe(this.player);
    this.visibilityObserver = new IntersectionObserver(() => this.refreshVisibility());
    this.visibilityObserver.observe(video);
    this.attachToPlayer();
    this.setScale(fontScale);
    this.applyMode();
    video.addEventListener("timeupdate", this.onTime);
    video.addEventListener("play", this.onPlay);
    video.addEventListener("pause", this.onPause);
    video.addEventListener("ended", this.onPause);
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("seeked", this.onSeeked);
    video.addEventListener("ratechange", this.onTime);
    video.addEventListener("loadedmetadata", this.onLoaded);
    video.addEventListener("emptied", this.onLoaded);
    video.addEventListener("loadstart", this.onLoaded);
    video.textTracks.addEventListener("addtrack", this.refreshTracks);
    video.textTracks.addEventListener("removetrack", this.refreshTracks);
    video.textTracks.addEventListener("change", this.refreshTracks);
    document.addEventListener("fullscreenchange", this.onFullscreen);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.refreshTracks();
    this.refreshVisibility();
  }

  setScale(scale: number): void {
    this.overlay.style.setProperty("--bbt-subtitle-scale", String(scale));
    this.scaleInput.value = String(scale);
  }

  setGlobalMode(mode: TranslationMode): void {
    this.mode = globalVideoEnabled ? this.manualMode ?? mode : "off";
    if (!globalVideoEnabled) this.interactionGeneration += 1;
    this.applyMode();
  }

  private chooseMode(mode: TranslationMode): void {
    if (!globalVideoEnabled || this.disposed) return;
    this.manualMode = mode;
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    for (const control of [this.modeButton, this.modeSelect, this.sourceSelect, this.importButton, this.fileInput]) control.disabled = !globalVideoEnabled;
    this.asrButton.disabled = !globalVideoEnabled || this.asrStarting;
    this.modeSelect.value = this.mode;
    const label = !globalVideoEnabled ? "已关闭" : this.mode === "off" ? "原生" : this.mode === "bilingual" ? "双语" : "译文";
    this.modeButton.textContent = `字幕 · ${label}`;
    this.modeButton.setAttribute("aria-label", globalVideoEnabled ? `字幕模式：${label}，点击切换` : "视频翻译已全局关闭");
    this.modeButton.setAttribute("aria-pressed", String(this.mode !== "off"));
    if (!globalVideoEnabled) this.setStatus(DISABLED_STATUS);
    else if (this.status.textContent === DISABLED_STATUS) this.setStatus(DEFAULT_STATUS);
    if (this.mode === "off") {
      this.scheduler.setEnabled(false);
      this.hide();
      this.stopClock();
      this.restoreTracks();
      this.stopAsr(this.asr.active || this.asrStarting ? "已停止听译。" : undefined);
    } else {
      this.refreshTracks();
      this.syncNativeTrack();
      this.schedule(true);
      this.queueRender();
      this.startClock();
    }
  }

  installSource(source: CaptionSource, select = false): void {
    if (!source.cues.length || this.disposed) return;
    this.sources.set(source.id, source);
    this.sourcesDirty = true;
    this.updateSourceOptions(select ? source.id : undefined);
  }

  private selectSource(source: CaptionSource): void {
    if (this.selectedSource === source) return;
    const signature = `${source.id}:${source.language}:${captionTextKey(JSON.stringify(source.cues))}`;
    this.selectedSource = source;
    if (signature === this.sourceSignature) return;
    const changed = source.id !== this.sourceId;
    this.sourceSignature = signature;
    this.sourceId = source.id;
    this.sourceSelect.value = this.sourceAliases.get(source.id) ?? source.id;
    if (changed && source.id !== "asr") {
      this.asrDelayMs = 0;
      if (this.asr.active || this.asrStarting) this.stopAsr("已切换字幕轨道，听译已停止。");
    }
    this.scheduler.setSource(source.id, source.cues, source.language);
    this.lastSchedule = "";
    this.syncNativeTrack();
    this.schedule(true);
    this.queueRender();
    this.startClock();
  }

  refreshTracks = (): void => {
    if (this.disposed) return;
    const tracks = Array.from(this.video.textTracks).filter((track) => ["subtitles", "captions"].includes(track.kind) && track.label !== "babata");
    for (const [track, listener] of this.watchedTracks) {
      if (!tracks.includes(track)) {
        track.removeEventListener("cuechange", listener);
        this.watchedTracks.delete(track);
        this.trackSnapshots.delete(track);
        if (this.sources.delete(trackId(track))) this.sourcesDirty = true;
        this.savedTrackModes.delete(track);
      }
    }
    const selected = this.sources.get(this.sourceId)?.track;
    const preferred = tracks.find((track) => track.mode === "showing") || selected || tracks[0];
    if (preferred && this.mode !== "off" && (!this.sourceId || this.sourceId.startsWith("track:"))) this.hideNativeTrack(preferred);
    for (const track of tracks) {
      if (!this.watchedTracks.has(track)) {
        const listener = () => { this.refreshTracks(); this.queueRender(); };
        this.watchedTracks.set(track, listener);
        track.addEventListener("cuechange", listener);
      }
      const cues = track.cues;
      if (!cues?.length) {
        if (this.sources.delete(trackId(track))) this.sourcesDirty = true;
        this.trackSnapshots.delete(track);
        continue;
      }
      const first = cues[0] as VTTCue;
      const last = cues[cues.length - 1] as VTTCue;
      const snapshot = `${track.kind}:${track.label}:${track.language}:${cues.length}:${first.startTime}:${first.text}:${last.startTime}:${last.endTime}:${last.text}`;
      const fingerprint = (cue: TextTrackCue) => `${cue.startTime}:${cue.endTime}:${(cue as VTTCue).text}`;
      const active = Array.from(track.activeCues ?? []);
      // Some custom players expose cues without activeCues. Inspect only the
      // current raw cue by binary search instead of rescanning the transcript.
      if (!active.length) {
        let low = 0;
        let high = cues.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (cues[middle].startTime <= this.video.currentTime) low = middle + 1;
          else high = middle;
        }
        if (low > 0 && cues[low - 1].endTime > this.video.currentTime) active.push(cues[low - 1]);
      }
      if (this.trackSnapshots.get(track) === snapshot && active.every((cue) => this.cueSnapshots.get(cue) === fingerprint(cue))) continue;
      this.trackSnapshots.set(track, snapshot);
      for (const cue of Array.from(cues)) this.cueSnapshots.set(cue, fingerprint(cue));
      const id = trackId(track);
      this.sources.set(id, { id, label: track.label || track.language || `字幕 ${tracks.indexOf(track) + 1}`, language: track.language, cues: cuesFromTextTrack(track), track });
      this.sourcesDirty = true;
    }
    // Reconcile once after all tracks are present. Selecting during the loop
    // can dispatch a copy first and its canonical track a moment later.
    this.updateSourceOptions(preferred && (!this.sourceId || this.sourceId.startsWith("track:")) ? trackId(preferred) : undefined);
  };

  private updateSourceOptions(preferredId?: string): void {
    if (this.sourcesDirty) {
      const grouped = groupCaptionSources([...this.sources.values()]);
      this.sourceAliases = grouped.aliases;
      this.sourceOptions = grouped.sources;
      this.sourcesDirty = false;
    }
    const options = this.sourceOptions.map((source) => ({ id: source.id, label: source.label }));
    const signature = JSON.stringify(options);
    if (this.sourceSelect.dataset.signature !== signature) {
      this.sourceSelect.dataset.signature = signature;
      this.sourceSelect.replaceChildren();
      if (!options.length) this.sourceSelect.add(new Option("等待网站字幕", ""));
      for (const option of options) this.sourceSelect.add(new Option(option.label, option.id));
    }
    let selected = this.sources.get(this.sourceId);
    const preferred = preferredId && this.sources.get(this.sourceAliases.get(preferredId) ?? preferredId);
    // Keep an existing member of the selected group and its translation cache.
    // The canonical ID represents that group in the UI; it is not an instruction
    // to switch a live source whenever the website adds a duplicate track.
    if (preferred && (!selected || this.sourceAliases.get(selected.id) !== preferred.id)) selected = preferred;
    selected ??= this.sourceOptions[0];
    if (selected) this.selectSource(selected);
    else if (this.sourceId) this.clearCaptionState();
    this.sourceSelect.value = this.sourceAliases.get(this.sourceId) ?? this.sourceId;
  }

  private hideNativeTrack(track: TextTrack): void {
    if (!this.savedTrackModes.has(track)) this.savedTrackModes.set(track, track.mode);
    if (track.mode !== "hidden") track.mode = "hidden";
  }

  private syncNativeTrack(): void {
    if (this.mode === "off") return;
    const selected = this.sources.get(this.sourceId)?.track;
    for (const track of Array.from(this.video.textTracks)) {
      if (track === this.fullscreenTrack) continue;
      if (track === selected || track.mode === "showing") this.hideNativeTrack(track);
    }
  }

  private restoreTracks(): void {
    for (const [track, mode] of this.savedTrackModes) {
      try { track.mode = mode; } catch { /* detached track */ }
    }
    this.savedTrackModes.clear();
  }

  private effectiveTime(): number { return Math.max(0, this.video.currentTime * 1000 - (this.sourceId === "asr" ? this.asrDelayMs : 0)); }

  refreshVisibility = (): void => {
    if (this.disposed) return;
    const rect = this.video.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < innerHeight && rect.left < innerWidth
      && this.video.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    if (visible === this.visible) return;
    this.visible = visible;
    this.onVisibility();
  };

  private canTranslate(): boolean {
    return globalVideoEnabled && this.visible && document.visibilityState !== "hidden" && !suspended && !this.disposed && this.mode !== "off";
  }

  private onVisibility = (): void => {
    this.schedule(true);
    if (this.canTranslate()) { this.queueRender(); this.startClock(); }
    else {
      this.stopClock();
      // A background tab keeps its last surface for a stable return. A player
      // hidden by the page must not leave captions floating over other content.
      if (document.visibilityState !== "hidden") this.hide();
    }
  };

  private schedule(force = false): void {
    if (!this.canTranslate()) { if (this.scheduler.enabled) this.scheduler.setEnabled(false); return; }
    if (this.seeking || !this.sourceId) return;
    const time = this.effectiveTime();
    const index = this.scheduler.timeline.indexAt(time);
    const prefetch = !this.video.paused && !this.video.ended;
    const key = `${index}:${this.video.playbackRate}:${prefetch}`;
    if (!force && key === this.lastSchedule && performance.now() - this.lastScheduledAt < 600) return;
    this.lastSchedule = key;
    this.lastScheduledAt = performance.now();
    this.scheduler.setEnabled(true, time, this.video.playbackRate, prefetch);
  }

  private queueRender(): void {
    if (this.renderQueued || this.disposed) return;
    this.renderQueued = true;
    queueMicrotask(() => { this.renderQueued = false; if (!this.disposed) this.render(); });
  }

  private render(): void {
    if (suspended || navigating || this.mode === "off" || !this.video.isConnected) { this.hide(); return; }
    if (!this.canTranslate()) { if (document.visibilityState !== "hidden") this.hide(); return; }
    this.attachToPlayer();
    this.schedule();
    const index = this.scheduler.timeline.indexAt(this.effectiveTime());
    const cue = this.scheduler.timeline.cues[index];
    if (!cue) { this.hide(); return; }
    const translated = this.scheduler.translated(cue);
    // Keep one stable caption surface while a request is pending. The original
    // remains readable; only the text row changes when its translation arrives.
    const text = translated || cue.text;
    const bilingual = this.mode === "bilingual" && !!translated && translated !== cue.text;
    const key = `${this.sourceId}:${index}:${text}:${bilingual}`;
    if (key !== this.lastRender) {
      this.lastRender = key;
      this.original.hidden = !bilingual;
      if (bilingual) this.original.textContent = cue.text;
      this.translation.textContent = text;
      this.overlay.dataset.state = translated ? "ready" : "pending";
    }
    this.overlay.style.display = "flex";
    if (!this.player.classList.contains(ACTIVE_CLASS)) this.player.classList.add(ACTIVE_CLASS);
    this.renderNativeFullscreen(cue, text, bilingual);
  }

  private attachToPlayer(): void {
    const next = playerFor(this.video);
    if (next === this.player && this.overlay.parentElement === next && this.controls.parentElement === next) return;
    if (this.player !== next) {
      this.resizeObserver.unobserve(this.player);
      this.player.classList.remove(ACTIVE_CLASS);
      if (this.previousPosition !== undefined) this.player.style.position = this.previousPosition;
      this.previousPosition = undefined;
      this.player = next;
      this.resizeObserver.observe(next);
    }
    if (getComputedStyle(this.player).position === "static") {
      this.previousPosition ??= this.player.style.position;
      this.player.style.position = "relative";
    }
    if (this.overlay.parentElement !== this.player) this.player.append(this.overlay);
    if (this.controls.parentElement !== this.player) this.player.append(this.controls);
    this.updateLayout();
  }

  private updateLayout(): void {
    const player = this.player.getBoundingClientRect();
    const video = this.video.getBoundingClientRect();
    // Metadata-only/test players have no video box yet; fall back to the known
    // player area. Normal pages anchor captions to the video, not a tall article.
    const hasVideoBox = video.width > 0 && video.height > 0;
    const left = hasVideoBox ? video.left - player.left + this.player.scrollLeft : 0;
    const top = hasVideoBox ? video.top - player.top + this.player.scrollTop : 0;
    const width = hasVideoBox ? video.width : player.width;
    const height = hasVideoBox ? video.height : player.height;
    this.overlay.style.setProperty("--bbt-overlay-left", `${left}px`);
    this.overlay.style.setProperty("--bbt-overlay-width", `${width}px`);
    this.overlay.style.setProperty("--bbt-overlay-bottom", `${Math.max(0, this.player.clientHeight - top - height + height * 0.11)}px`);
    this.controls.style.setProperty("--bbt-controls-left", `${left + width - 10}px`);
    this.controls.style.setProperty("--bbt-controls-top", `${top + 10}px`);
  }

  private renderNativeFullscreen(cue: CaptionCue, text: string, bilingual: boolean): void {
    if (document.fullscreenElement !== this.video) { this.clearFullscreenTrack(); return; }
    this.fullscreenTrack ??= Array.from(this.video.textTracks).find((track) => track.label === "babata")
      || this.video.addTextTrack("subtitles", "babata", "zh");
    const key = `${cue.startMs}:${cue.endMs}:${text}:${bilingual}`;
    if (key !== this.fullscreenKey) {
      for (const existing of Array.from(this.fullscreenTrack.cues ?? [])) this.fullscreenTrack.removeCue(existing);
      const offset = this.sourceId === "asr" ? this.asrDelayMs : 0;
      const native = new VTTCue((cue.startMs + offset) / 1000, (cue.endMs + offset) / 1000, bilingual ? `${cue.text}\n${text}` : text);
      this.fullscreenTrack.addCue(native);
      this.fullscreenKey = key;
    }
    this.fullscreenTrack.mode = "showing";
  }

  private clearFullscreenTrack(): void {
    if (this.fullscreenTrack && this.fullscreenTrack.mode !== "disabled") this.fullscreenTrack.mode = "disabled";
    this.fullscreenKey = "";
  }

  private hide(): void {
    this.overlay.style.display = "none";
    this.player.classList.remove(ACTIVE_CLASS);
    this.lastRender = "";
    this.clearFullscreenTrack();
  }

  private startClock(): void {
    if (!this.canTranslate() || this.video.paused || this.video.ended || this.frame || this.videoFrame) return;
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.videoFrame = this.video.requestVideoFrameCallback(() => { this.videoFrame = 0; this.render(); this.startClock(); });
    } else {
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); this.startClock(); });
    }
  }

  private stopClock(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.videoFrame) this.video.cancelVideoFrameCallback?.(this.videoFrame);
    this.frame = 0;
    this.videoFrame = 0;
  }

  private onTime = () => { this.refreshVisibility(); this.schedule(); this.queueRender(); };
  private onFullscreen = () => { this.updateLayout(); this.queueRender(); };
  private onPlay = () => { this.refreshVisibility(); this.schedule(true); this.queueRender(); this.startClock(); };
  private onPause = () => { this.stopClock(); this.schedule(true); this.queueRender(); };
  private onSeeking = () => {
    this.seeking = true;
    this.scheduler.setDispatchPaused(true);
    if (this.asr.active || this.asrStarting) this.stopAsr("已停止听译，请在新位置重新开启。");
    this.queueRender();
  };
  private onSeeked = () => {
    this.seeking = false;
    this.scheduler.setDispatchPaused(false);
    this.lastSchedule = "";
    this.schedule(true);
    this.queueRender();
  };
  private onLoaded = () => {
    const key = this.video.currentSrc || this.video.getAttribute("src") || "";
    if (key !== this.mediaKey) { this.mediaKey = key; this.reset(); }
    this.refreshTracks();
    this.queueRender();
  };

  private clearCaptionState(): void {
    this.scheduler.cancel();
    this.scheduler.setSource("", []);
    this.sourceId = "";
    this.sourceSignature = "";
    this.selectedSource = undefined;
    this.lastSchedule = "";
    this.hide();
  }

  reset(): void {
    this.clearCaptionState();
    this.seeking = false;
    this.scheduler.setDispatchPaused(false);
    this.sources.clear();
    this.sourcesDirty = true;
    this.trackSnapshots.clear();
    this.asrCues = [];
    this.asrDelayMs = 0;
    this.stopAsr();
    this.restoreTracks();
    this.updateSourceOptions();
    this.stopClock();
  }

  suspend(): void { this.scheduler.setEnabled(false); this.stopClock(); this.stopAsr(); this.hide(); this.restoreTracks(); }
  resume(): void { this.applyMode(); }

  invalidate(scope: string): void {
    if (scope === "translation" || scope === "all") { this.scheduler.invalidate(); this.lastRender = ""; this.queueRender(); }
    if (scope === "transcription" || scope === "all") this.stopAsr("语音识别设置已更新，请重新开启听译。");
  }

  private stopAsr(message?: string): void {
    this.asrStartSequence += 1;
    this.asrStarting = false;
    this.asr.stop();
    this.asrButton.textContent = "听译（无字幕）";
    this.asrButton.disabled = !globalVideoEnabled;
    if (message) this.setStatus(message);
  }

  private setStatus(message: string): void { this.status.textContent = globalVideoEnabled ? message : DISABLED_STATUS; }

  dispose(): void {
    this.disposed = true;
    this.suspend();
    this.overlay.remove();
    this.controls.remove();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    if (this.previousPosition !== undefined) this.player.style.position = this.previousPosition;
    const events: Array<[string, EventListener]> = [
      ["timeupdate", this.onTime], ["play", this.onPlay], ["pause", this.onPause], ["ended", this.onPause],
      ["seeking", this.onSeeking], ["seeked", this.onSeeked], ["ratechange", this.onTime],
      ["loadedmetadata", this.onLoaded], ["emptied", this.onLoaded], ["loadstart", this.onLoaded],
    ];
    for (const [name, handler] of events) this.video.removeEventListener(name, handler);
    for (const name of ["addtrack", "removetrack", "change"]) this.video.textTracks.removeEventListener(name, this.refreshTracks);
    document.removeEventListener("fullscreenchange", this.onFullscreen);
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const [track, listener] of this.watchedTracks) track.removeEventListener("cuechange", listener);
  }
}

function discover(root: ParentNode = document): void {
  const videos = root instanceof HTMLVideoElement ? [root] : Array.from(root.querySelectorAll("video"));
  let added = false;
  for (const video of videos) if (!controllers.has(video)) {
    controllers.set(video, new VideoSubtitleController(video));
    added = true;
  }
  for (const [video, controller] of controllers) {
    if (!video.isConnected) { controller.dispose(); controllers.delete(video); }
  }
  if (added) requestLastCaption();
}

function requestLastCaption(): void {
  window.postMessage({ source: "babata-youtube-subtitles", type: "babata.youtube_caption_request" }, "*");
}

const recentCaptions = new Map<string, string>();
function processCaptionResponse(rawUrl: string, body: string, capturedPage?: string): void {
  if (navigating || suspended || body.length > 2_000_000) return;
  let url: URL;
  try { url = new URL(rawUrl, location.href); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  const youtube = /(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname) && url.pathname === "/api/timedtext";
  if (youtube) {
    const requested = url.searchParams.get("v");
    if (requested && requested !== currentPageKey()) return;
  } else if (!/\.(?:vtt|srt|json3)(?:$|\/)/i.test(url.pathname)) return;
  if (capturedPage && capturedPage !== location.href) return;
  if (pageKey !== currentPageKey()) resetPage();
  const fingerprint = captionTextKey(body, "caption");
  if (recentCaptions.get(rawUrl) === fingerprint) return;
  const cues = parseCaptionBody(body);
  if (!cues.length) return;
  discover();
  const matching = [...controllers.values()].filter((controller) => [...controller.video.querySelectorAll("track")].some((track) => track.src === url.href));
  const candidates = matching.length ? matching : [...controllers.values()].filter((controller) => !controller.video.paused);
  const target = matching[0] || (candidates.length === 1 ? candidates[0] : controllers.size === 1 ? controllers.values().next().value : undefined);
  if (!target) return; // Never attach a track to an arbitrary player on a multi-video page.
  recentCaptions.set(rawUrl, fingerprint);
  if (recentCaptions.size > 30) recentCaptions.delete(recentCaptions.keys().next().value!);
  const trackElement = [...target.video.querySelectorAll("track")].find((track) => track.src === url.href);
  const language = url.searchParams.get("tlang") || url.searchParams.get("lang") || trackElement?.srclang || "";
  target.installSource({
    id: `network:${pageKey}:${url.origin}${url.pathname}:${language}`,
    label: language ? `网站字幕 · ${language}` : "网站字幕", language, cues,
  }, youtube);
}

listen(window, "message", (rawEvent) => {
  const event = rawEvent as MessageEvent;
  if (event.source !== window || event.data?.source !== "babata-youtube-subtitles-main") return;
  const data = event.data as { type?: string; url?: string; response?: string; pageUrl?: string };
  if (data.type === "babata.youtube_caption_ready") { requestLastCaption(); return; }
  if (data.type !== "babata.youtube_caption_response" || typeof data.url !== "string" || typeof data.response !== "string") return;
  processCaptionResponse(data.url, data.response, data.pageUrl);
});

function resetPage(): void {
  pageKey = currentPageKey();
  recentCaptions.clear();
  for (const controller of controllers.values()) controller.reset();
}

async function refreshSettings(): Promise<void> {
  const sequence = ++settingsSequence;
  try {
    const settings = await chrome.storage.local.get([STORAGE_TRANSLATION_MODE, STORAGE_VIDEO_TRANSLATION, FONT_KEY]);
    if (destroyed || sequence !== settingsSequence) return;
    globalVideoEnabled = isVideoTranslationEnabled(settings[STORAGE_VIDEO_TRANSLATION]);
    globalMode = normalizeTranslationRenderMode(settings[STORAGE_TRANSLATION_MODE]);
    const scale = Number(settings[FONT_KEY]);
    fontScale = Number.isFinite(scale) ? Math.max(0.7, Math.min(1.6, scale)) : 1;
    for (const controller of controllers.values()) { controller.setGlobalMode(globalMode); controller.setScale(fontScale); }
  } catch {
    if (destroyed || sequence !== settingsSequence) return;
    globalVideoEnabled = false;
    for (const controller of controllers.values()) controller.setGlobalMode(globalMode);
  }
}

const observer = new MutationObserver((records) => {
  let cleanup = false;
  for (const record of records) {
    if (record.type === "attributes" && record.target instanceof Element) {
      for (const [video, controller] of controllers) if (record.target.contains(video)) controller.refreshVisibility();
      continue;
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof Element) || node.closest("bbt-video-controls,.bbt-video-overlay")) continue;
      if (node instanceof HTMLTrackElement) controllers.get(node.parentElement as HTMLVideoElement)?.refreshTracks();
      if (node instanceof HTMLVideoElement || node.querySelector("video")) discover(node);
      for (const track of node.querySelectorAll("track")) controllers.get(track.parentElement as HTMLVideoElement)?.refreshTracks();
    }
    if (record.removedNodes.length) cleanup = true;
  }
  if (cleanup) for (const [video, controller] of controllers) if (!video.isConnected) { controller.dispose(); controllers.delete(video); }
});

function begin(): void {
  if (destroyed || !document.documentElement) return;
  document.documentElement.setAttribute("data-bbt-video-translate-version", "2");
  discover();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  requestLastCaption();
}
if (document.documentElement) begin();
else listen(document, "DOMContentLoaded", begin, { once: true });
listen(document, "load", (event) => { if (event.target instanceof HTMLTrackElement) controllers.get(event.target.parentElement as HTMLVideoElement)?.refreshTracks(); }, true);
const onVisibilityMotionEnd = (event: Event) => {
  if (!(event.target instanceof Element)) return;
  for (const [video, controller] of controllers) if (event.target.contains(video)) controller.refreshVisibility();
};
listen(document, "transitionend", onVisibilityMotionEnd, true);
listen(document, "animationend", onVisibilityMotionEnd, true);
listen(document, "yt-navigate-start", () => { navigating = true; resetPage(); });
listen(document, "yt-navigate-finish", () => { navigating = false; if (pageKey !== currentPageKey()) resetPage(); discover(); requestLastCaption(); });
listen(window, "popstate", () => { if (pageKey !== currentPageKey()) resetPage(); });
listen(window, "pagehide", () => { suspended = true; for (const controller of controllers.values()) controller.suspend(); });
listen(window, "pageshow", () => { suspended = false; for (const controller of controllers.values()) controller.resume(); requestLastCaption(); void refreshSettings(); });
const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  if (area !== "local") return;
  // Closing the global gate must cancel immediately, even if storage reads are slow.
  if (STORAGE_VIDEO_TRANSLATION in changes && !isVideoTranslationEnabled(changes[STORAGE_VIDEO_TRANSLATION].newValue)) {
    globalVideoEnabled = false;
    for (const controller of controllers.values()) controller.setGlobalMode(globalMode);
  }
  if ([STORAGE_TRANSLATION_MODE, STORAGE_VIDEO_TRANSLATION, FONT_KEY].some((key) => key in changes)) void refreshSettings();
};
chrome.storage.onChanged.addListener(onStorageChanged);
cleanups.push(() => chrome.storage.onChanged.removeListener(onStorageChanged));
const onRuntimeMessage = (message: { type?: string; scope?: string }) => {
  if (message?.type === "babata.translation_config_changed") for (const controller of controllers.values()) controller.invalidate(message.scope ?? "all");
};
chrome.runtime.onMessage.addListener(onRuntimeMessage);
cleanups.push(() => chrome.runtime.onMessage.removeListener(onRuntimeMessage));
listen(document, TEARDOWN_EVENT, () => {
  if (destroyed) return;
  destroyed = true;
  settingsSequence += 1;
  observer.disconnect();
  for (const controller of controllers.values()) controller.dispose();
  controllers.clear();
  recentCaptions.clear();
  for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* An old extension world may already be invalidated. */ } }
  document.getElementById("bbt-youtube-subtitle-style")?.remove();
  document.documentElement?.removeAttribute("data-bbt-video-translate-version");
  videoWindow.__babataVideoTranslateBooted = false;
});
void refreshSettings();
}
