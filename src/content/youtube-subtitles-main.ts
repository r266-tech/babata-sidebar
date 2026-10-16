const captionWindow = window as Window & { __babataVideoCaptionCaptureBooted?: boolean };
if (!captionWindow.__babataVideoCaptionCaptureBooted) installCaptionCapture();

function installCaptionCapture(): void {
if (typeof document !== "undefined" && document.documentElement?.getAttribute("data-bbt-video-translate-version") !== "2"
  && document.querySelector('bbt-video-controls[data-bbt-video],.bbt-video-overlay[data-bbt-youtube-subtitles="1"],#bbt-youtube-subtitle-overlay[data-bbt-youtube-subtitles="1"]')) return;
captionWindow.__babataVideoCaptionCaptureBooted = true;
const BBT_YT_CAPTION_MESSAGE = "babata.youtube_caption_response";
const MAX_CAPTION_BYTES = 2_000_000;
const lastCaptions = new Map<string, { url: string; response: string; pageUrl: string }>();

function captionUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isCaptionUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, location.href);
    if (!/^https?:$/.test(url.protocol)) return false;
    const youtube = /(^|\.)youtube(?:-nocookie)?\.com$/.test(new URL(location.href).hostname);
    return (youtube && url.pathname === "/api/timedtext") || /\.(?:vtt|srt|json3)(?:$|\/)/i.test(url.pathname);
  } catch { return false; }
}

function postCaptionResponse(url: string, response: string, pageUrl: string) {
  if (!response || response.length > MAX_CAPTION_BYTES || pageUrl !== location.href) return;
  lastCaptions.delete(url);
  lastCaptions.set(url, { url, response, pageUrl });
  while (lastCaptions.size > 8) lastCaptions.delete(lastCaptions.keys().next().value!);
  while (lastCaptions.size > 1 && [...lastCaptions.values()].reduce((sum, item) => sum + item.response.length, 0) > 4_000_000) {
    lastCaptions.delete(lastCaptions.keys().next().value!);
  }
  window.postMessage({ source: "babata-youtube-subtitles-main", type: BBT_YT_CAPTION_MESSAGE, url, response, pageUrl }, "*");
}

// Only explicitly identified caption responses are inspected. This hook never
// fetches media or arbitrary JSON, and leaves the original fetch/XHR untouched.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "babata-youtube-subtitles") return;
  if (event.data.type !== "babata.youtube_caption_request") return;
  for (const item of [...lastCaptions.values()]) if (item.pageUrl === location.href) postCaptionResponse(item.url, item.response, item.pageUrl);
});
window.postMessage({ source: "babata-youtube-subtitles-main", type: "babata.youtube_caption_ready" }, "*");

const xhrRequests = new WeakMap<XMLHttpRequest, { url: string; pageUrl: string }>();
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
  const rawUrl = typeof url === "string" ? url : url.href;
  if (isCaptionUrl(rawUrl)) xhrRequests.set(this, { url: rawUrl, pageUrl: location.href });
  else xhrRequests.delete(this);
  return Reflect.apply(originalOpen, this, [method, url, async, username, password]) as void;
};
XMLHttpRequest.prototype.send = function send(body?: XMLHttpRequestBodyInit | null) {
  const request = xhrRequests.get(this);
  if (request) this.addEventListener("load", () => {
    if (xhrRequests.get(this) !== request || this.status < 200 || this.status >= 300) return;
    try {
      const response = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
      if (typeof response === "string") postCaptionResponse(request.url, response, request.pageUrl);
    } catch { /* Non-text responses are not captions. */ }
  }, { once: true });
  return Reflect.apply(originalSend, this, [body]) as void;
};

async function captionText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_CAPTION_BYTES) return "";
  const clone = response.clone();
  if (!clone.body) return "";
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CAPTION_BYTES) { void reader.cancel().catch(() => {}); return ""; }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const pageUrl = location.href;
  const response = await originalFetch(input, init);
  const url = response.url || captionUrl(input);
  if (response.ok && isCaptionUrl(url)) {
    void captionText(response).then((body) => postCaptionResponse(url, body, pageUrl)).catch(() => {});
  }
  return response;
};
}
export {};
