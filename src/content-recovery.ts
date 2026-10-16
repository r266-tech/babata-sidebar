/// <reference types="chrome" />

type RecoveryApi = Pick<typeof chrome, "runtime" | "tabs" | "scripting">;

const TRANSLATION_ENTRY = /(?:^|\/)babata-translate(?:\.ts)?(?:-loader-[^/]+)?\.(?:js|ts)$/;

export function translationContentFiles(manifest: chrome.runtime.Manifest): string[] {
  // CRX builds replace the source entry with a hashed loader. Resolve the
  // installed manifest rather than retaining a source path or build hash.
  return manifest.content_scripts?.flatMap((entry) => "world" in entry && entry.world === "MAIN"
    ? [] : (entry.js ?? []).filter((file) => TRANSLATION_ENTRY.test(file))) ?? [];
}

function probeTranslationEngine(): boolean {
  // DOM attributes and translated text can outlive an invalidated extension
  // context. Read the current extension's isolated-world state instead.
  return (window as unknown as { __babataTranslateBooted?: boolean }).__babataTranslateBooted === true;
}

function eligibleTab(tab: chrome.tabs.Tab): boolean {
  return typeof tab.id === "number" && !tab.discarded && /^https?:\/\//i.test(tab.url ?? "");
}

export function createTranslationContentRecovery(api: RecoveryApi) {
  const inFlight = new Map<number, Promise<void>>();

  function recoverTab(tabId: number): Promise<void> {
    const existing = inFlight.get(tabId);
    if (existing) return existing;
    const work = (async () => {
      try {
        const tab = await api.tabs.get(tabId);
        if (!eligibleTab(tab)) return;
        const files = translationContentFiles(api.runtime.getManifest());
        if (!files.length) return;
        const frames = await api.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "ISOLATED",
          func: probeTranslationEngine,
        });
        const missing = new Set(frames.filter((frame) => frame.result === false
          && typeof frame.documentId === "string" && frame.documentId.length > 0)
          .map((frame) => frame.documentId));
        // A navigation or detached frame must not redirect injection to its
        // replacement document, nor prevent recovery of the other frames.
        await Promise.allSettled([...missing].map((documentId) => api.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          world: "ISOLATED",
          files,
        })));
      } catch {
        // Closed tabs and browser-protected pages are expected during startup.
      }
    })().finally(() => {
      if (inFlight.get(tabId) === work) inFlight.delete(tabId);
    });
    inFlight.set(tabId, work);
    return work;
  }

  async function recoverExistingTabs(): Promise<void> {
    try {
      const tabs = (await api.tabs.query({ url: ["http://*/*", "https://*/*"] }))
        .filter(eligibleTab).sort((a, b) => Number(b.active) - Number(a.active));
      let cursor = 0;
      // Bound startup work even when a browser restores hundreds of tabs.
      await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, async () => {
        while (cursor < tabs.length) await recoverTab(tabs[cursor++].id!);
      }));
    } catch {
      // A later activation can recover a page if startup enumeration failed.
    }
  }

  return { recoverTab, recoverExistingTabs };
}
