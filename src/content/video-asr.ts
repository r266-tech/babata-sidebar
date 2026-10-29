import { getTranscriptionCapabilities, requestTranscription } from "./translation-client";
import type { CaptionCue } from "./youtube-captions";

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream };

/** Captures only the selected player's available audio track after an explicit
 * click. Each recorder produces a complete, independently decodable container;
 * MediaRecorder timeslice fragments are deliberately not posted as files. */
export class VideoTranscription {
  active = false;
  private generation = 0;
  private stream: MediaStream | undefined;
  private ownedCaptureTracks: MediaStreamTrack[] = [];
  private recorder: MediaRecorder | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private meterTimer: ReturnType<typeof setInterval> | undefined;
  private audioContext: AudioContext | undefined;
  private analyser: AnalyserNode | undefined;
  private maxRms = 0;
  private samples = 0;
  private requests = new Set<AbortController>();
  private chunkSeconds = 12;
  private maxBytes = 4 * 1024 * 1024;
  private sequence = 0;

  constructor(
    private video: HTMLVideoElement,
    private onCues: (cues: CaptionCue[], language: string, chunkStartMs: number) => void,
    private onStatus: (message: string, active: boolean) => void,
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    const token = ++this.generation;
    if (this.video.paused || this.video.ended) throw new Error("请先播放视频，再开启听译。");
    const capture = (this.video as CapturableVideo).captureStream;
    if (typeof capture !== "function" || typeof MediaRecorder === "undefined") {
      throw new Error("此播放器不支持音轨采集；可以开启网站字幕或导入字幕文件。");
    }
    // Acquire synchronously in the user's click path. Do not substitute system
    // audio, microphone access, downloads, or protected-media extraction.
    const captured = capture.call(this.video);
    // captureStream() can return the exact source tracks for a srcObject
    // player. Never stop a track owned by the page's original media stream.
    const sourceTracks = new Set(this.video.srcObject instanceof MediaStream ? this.video.srcObject.getTracks() : []);
    const ownedCaptureTracks = captured.getTracks().filter((track) => !sourceTracks.has(track));
    const audio = captured.getAudioTracks().filter((track) => track.readyState === "live");
    if (!audio.length) {
      ownedCaptureTracks.forEach((track) => track.stop());
      throw new Error("无法读取此视频的音轨（可能受跨域或版权保护限制）；请使用网站字幕。");
    }
    this.ownedCaptureTracks = ownedCaptureTracks;
    this.stream = new MediaStream(audio.map((track) => track.clone()));
    try {
      const capabilities = await getTranscriptionCapabilities();
      if (token !== this.generation) return;
      if (!capabilities.ok || !capabilities.available) {
        throw new Error("尚未配置语音识别服务，请在扩展设置中配置“语音识别”。");
      }
      this.chunkSeconds = Math.min(12, capabilities.max_chunk_seconds);
      this.maxBytes = Math.min(4 * 1024 * 1024, capabilities.max_bytes);
      if (this.chunkSeconds < 1 || this.maxBytes < 1024) throw new Error("语音识别服务的音频限制无效。");
      this.active = true;
      this.startMeter();
      this.video.addEventListener("play", this.onPlay);
      this.video.addEventListener("pause", this.onPause);
      this.video.addEventListener("ratechange", this.onRateChange);
      this.video.addEventListener("ended", this.onPause);
      this.onStatus("正在听译，字幕约有 12–20 秒延迟。", true);
      this.recordChunk();
    } catch (error) {
      // A stopped attempt may reject after a newer explicit start has begun.
      if (token !== this.generation) return;
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    clearTimeout(this.timer);
    clearInterval(this.meterTimer);
    this.video.removeEventListener("play", this.onPlay);
    this.video.removeEventListener("pause", this.onPause);
    this.video.removeEventListener("ratechange", this.onRateChange);
    this.video.removeEventListener("ended", this.onPause);
    if (this.recorder?.state !== "inactive") {
      try { this.recorder?.stop(); } catch { /* already stopped */ }
    }
    this.recorder = undefined;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ownedCaptureTracks.forEach((track) => track.stop());
    this.stream = undefined;
    this.ownedCaptureTracks = [];
    void this.audioContext?.close().catch(() => {});
    this.audioContext = undefined;
    this.analyser = undefined;
  }

  private onPlay = () => { if (this.active && !this.recorder) this.recordChunk(); };
  private onPause = () => {
    clearTimeout(this.timer);
    if (this.recorder?.state === "recording") this.recorder.stop();
  };
  private onRateChange = () => {
    // Discard the interrupted chunk: one timestamp scale cannot describe audio
    // recorded at two playback rates. The next chunk gets a fresh container.
    this.generation += 1;
    clearTimeout(this.timer);
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    if (this.recorder?.state === "recording") this.recorder.stop();
    else this.recordChunk();
  };

  private startMeter(): void {
    try {
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.audioContext.createMediaStreamSource(this.stream!).connect(this.analyser);
      void this.audioContext.resume().catch(() => {});
      const data = new Float32Array(512);
      this.meterTimer = setInterval(() => {
        if (!this.analyser || this.audioContext?.state !== "running") return;
        this.analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        this.maxRms = Math.max(this.maxRms, rms);
        this.samples += 1;
      }, 100);
    } catch {
      // Level metering is optional; recording still works without Web Audio.
      this.analyser = undefined;
    }
  }

  private recordChunk(): void {
    if (!this.active || !this.stream || this.video.paused || this.video.ended || this.recorder) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mime) { this.stop(); this.onStatus("浏览器没有可用的音频录制格式。", false); return; }
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 64_000 }); }
    catch { this.stop(); this.onStatus("无法录制此播放器的音轨。", false); return; }
    this.recorder = recorder;
    const generation = this.generation;
    const startMs = this.video.currentTime * 1000;
    const rate = this.video.playbackRate;
    const started = performance.now();
    const parts: Blob[] = [];
    this.maxRms = 0;
    this.samples = 0;
    recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
    recorder.onerror = () => { this.stop(); this.onStatus("音轨录制失败，此播放器可能限制采集。", false); };
    recorder.onstop = () => {
      const duration = Math.min((performance.now() - started) / 1000, this.chunkSeconds);
      const silent = this.samples >= 5 && this.maxRms < 0.002;
      const blob = new Blob(parts, { type: mime });
      if (this.recorder === recorder) this.recorder = undefined;
      if (this.active && generation === this.generation && duration >= 0.5 && blob.size && !silent) {
        void this.transcribe(blob, duration, startMs, rate, generation);
      }
      if (this.active) this.recordChunk();
    };
    try { recorder.start(); }
    catch { this.stop(); this.onStatus("无法启动音轨录制。", false); return; }
    this.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, this.chunkSeconds * 1000);
  }

  private async transcribe(blob: Blob, duration: number, startMs: number, rate: number, generation: number): Promise<void> {
    if (blob.size > this.maxBytes) { this.onStatus("音频块超过服务限制，已跳过。", true); return; }
    if (this.requests.size >= 2) { this.onStatus("识别速度暂时跟不上播放，已跳过一段音频；可降低播放速度。", true); return; }
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!this.active || generation !== this.generation) return;
      let binary = "";
      for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      const result = await requestTranscription({
        audio_base64: btoa(binary), mime: blob.type, duration_seconds: duration,
        target: "zh", sequence: ++this.sequence,
      }, { signal: controller.signal });
      if (!this.active || generation !== this.generation || controller.signal.aborted) return;
      if (!result.ok) throw new Error(result.error || "语音识别失败，请检查服务设置。");
      const segments = result.segments?.length ? result.segments : [{ start: 0, end: duration, text: result.text }];
      const cues = segments.filter((segment) => segment.text.trim() && segment.start < duration && segment.end > segment.start)
        .map((segment) => ({
          startMs: startMs + Math.max(0, segment.start) * 1000 * rate,
          endMs: startMs + Math.min(duration, segment.end) * 1000 * rate,
          text: segment.text,
        }));
      if (cues.length) this.onCues(cues, result.language ?? "", startMs);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.onStatus(error instanceof Error ? error.message : "语音识别暂不可用。", this.active);
    } finally { this.requests.delete(controller); }
  }
}
