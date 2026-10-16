/// <reference types="chrome" />

type RecoveryApi = Pick<typeof chrome, "runtime" | "tabs" | "scripting">;

const TRANSLATION_ENTRY = /(?:^|\/)babata-translate(?:\.ts)?(?:-loader-[^/]+)?\.(?:js|ts)$/;
const VIDEO_ENTRY = /(?:^|\/)youtube-subtitles(?:\.ts)?(?:-loader-[^/]+)?\.(?:js|ts)$/;
const VIDEO_MAIN_ENTRY = /(?:^|\/)youtube-subtitles-main(?:\.ts)?(?:-(?:loader-)?[^/]+)?\.(?:js|ts)$/;

export type ContentRecoveryReport = {
  tabId: number;
  injected: { page: number; video: number; main: number };
  needs_refresh: Array<{ documentId: string; reason: "legacy_video_context" }>;
};

export function recoveryContentFiles(manifest: chrome.runtime.Manifest): { page: string[]; video: string[]; main: string[] } {
  const files = { page: [] as string[], video: [] as string[], main: [] as string[] };
  for (const entry of manifest.content_scripts ?? []) {
    const main = "world" in entry && entry.world === "MAIN";
    for (const file of entry.js ?? []) {
      if (main && VIDEO_MAIN_ENTRY.test(file)) files.main.push(file);
      else if (!main && VIDEO_ENTRY.test(file)) files.video.push(file);
      else if (!main && TRANSLATION_ENTRY.test(file)) files.page.push(file);
    }
  }
  return files;
}

export function translationContentFiles(manifest: chrome.runtime.Manifest): string[] {
  // CRX builds replace the source entry with a hashed loader. Resolve the
  // installed manifest rather than retaining a source path or build hash.
  return recoveryContentFiles(manifest).page;
}

function probeTranslationEngines(): { page: boolean; video: boolean; legacyVideo: boolean } {
  // DOM attributes and translated text can outlive an invalidated extension
  // context. Read the current extension's isolated-world state instead.
  const current = window as unknown as { __babataTranslateBooted?: boolean; __babataVideoTranslateBooted?: boolean };
  // Only our own DOM signatures indicate an old controller. A site's matching
  // CSS class alone must not make an otherwise recoverable document look old.
  const videoDom = document.querySelector('bbt-video-controls[data-bbt-video],.bbt-video-overlay[data-bbt-youtube-subtitles="1"],#bbt-youtube-subtitle-overlay[data-bbt-youtube-subtitles="1"]');
  const canTeardown = document.documentElement?.getAttribute("data-bbt-video-translate-version") === "2";
  return {
    page: current.__babataTranslateBooted === true,
    video: current.__babataVideoTranslateBooted === true,
    legacyVideo: Boolean(videoDom) && !canTeardown,
  };
}

function probeVideoCapture(): boolean {
  return (window as unknown as { __babataVideoCaptionCaptureBooted?: boolean }).__babataVideoCaptionCaptureBooted === true;
}

function eligibleTab(tab: chrome.tabs.Tab): boolean {
  return typeof tab.id === "number" && !tab.discarded && /^https?:\/\//i.test(tab.url ?? "");
}

export function createTranslationContentRecovery(api: RecoveryApi) {
  const inFlight = new Map<number, Promise<ContentRecoveryReport>>();

  function recoverTab(tabId: number): Promise<ContentRecoveryReport> {
    const existing = inFlight.get(tabId);
    if (existing) return existing;
    const work = (async () => {
      const report: ContentRecoveryReport = { tabId, injected: { page: 0, video: 0, main: 0 }, needs_refresh: [] };
      try {
        const tab = await api.tabs.get(tabId);
        if (!eligibleTab(tab)) return report;
        const files = recoveryContentFiles(api.runtime.getManifest());
        if (!files.page.length && !files.video.length && !files.main.length) return report;
        const frames = await api.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "ISOLATED",
          func: probeTranslationEngines,
        });
        const documents = new Map(frames.filter((frame) => typeof frame.documentId === "string" && frame.documentId.length > 0
          && typeof frame.result?.page === "boolean" && typeof frame.result?.video === "boolean" && typeof frame.result?.legacyVideo === "boolean")
          .map((frame) => [frame.documentId, frame.result!]));
        // A navigation or detached frame must not redirect injection to its
        // replacement document, nor prevent recovery of the other frames.
        await Promise.allSettled([...documents].map(async ([documentId, state]) => {
          const target = { tabId, documentIds: [documentId] };
          const inject = async (kind: keyof typeof files, world: "ISOLATED" | "MAIN") => {
            if (!files[kind].length) return;
            try {
              await api.scripting.executeScript({ target, world, files: files[kind] });
              report.injected[kind]++;
            } catch { /* Navigation must not redirect injection to a new document. */ }
          };
          if (!state.page) await inject("page", "ISOLATED");
          if (state.legacyVideo) {
            report.needs_refresh.push({ documentId, reason: "legacy_video_context" });
            return; // Legacy controllers and MAIN hooks cannot be safely removed.
          }
          if (files.main.length) {
            try {
              const capture = await api.scripting.executeScript({ target, world: "MAIN", func: probeVideoCapture });
              if (capture.some((frame) => frame.documentId === documentId && frame.result === false)) await inject("main", "MAIN");
            } catch { /* A restricted frame can still recover its isolated engine. */ }
          }
          if (!state.video) await inject("video", "ISOLATED");
        }));
      } catch {
        // Closed tabs and browser-protected pages are expected during startup.
      }
      return report;
    })().finally(() => {
      if (inFlight.get(tabId) === work) inFlight.delete(tabId);
    });
    inFlight.set(tabId, work);
    return work;
  }

  async function recoverExistingTabs(): Promise<ContentRecoveryReport[]> {
    const reports: ContentRecoveryReport[] = [];
    try {
      const tabs = (await api.tabs.query({ url: ["http://*/*", "https://*/*"] }))
        .filter(eligibleTab).sort((a, b) => Number(b.active) - Number(a.active));
      let cursor = 0;
      // Bound startup work even when a browser restores hundreds of tabs.
      await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, async () => {
        while (cursor < tabs.length) reports.push(await recoverTab(tabs[cursor++].id!));
      }));
    } catch {
      // A later activation can recover a page if startup enumeration failed.
    }
    return reports;
  }

  return { recoverTab, recoverExistingTabs };
}
