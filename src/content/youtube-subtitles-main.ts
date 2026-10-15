const BBT_YT_CAPTION_MESSAGE = "babata.youtube_caption_response";
let lastCaption: { url: string; response: string } | undefined;

function captionUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isYoutubeCaptionUrl(url: string): boolean {
  if (!url) return false;
  try { return new URL(url, location.href).pathname === "/api/timedtext"; }
  catch { return false; }
}

function postCaptionResponse(url: string, response: string) {
  if (!response || response.length > 2_000_000) return;
  lastCaption = { url, response };
  window.postMessage({
    source: "babata-youtube-subtitles-main",
    type: BBT_YT_CAPTION_MESSAGE,
    url,
    response,
  }, "*");
}

// The isolated-world bundle may finish loading after the first caption fetch.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "babata-youtube-subtitles") return;
  if (event.data.type === "babata.youtube_caption_request" && lastCaption) {
    postCaptionResponse(lastCaption.url, lastCaption.response);
  }
});
window.postMessage({ source: "babata-youtube-subtitles-main", type: "babata.youtube_caption_ready" }, "*");

const xhrUrls = new WeakMap<XMLHttpRequest, string>();
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function open(
  method: string,
  url: string | URL,
  async = true,
  username?: string | null,
  password?: string | null,
) {
  const rawUrl = typeof url === "string" ? url : url.href;
  if (isYoutubeCaptionUrl(rawUrl)) xhrUrls.set(this, rawUrl);
  else xhrUrls.delete(this);
  return Reflect.apply(originalOpen, this, [method, url, async, username, password]) as void;
};

XMLHttpRequest.prototype.send = function send(body?: XMLHttpRequestBodyInit | null) {
  const url = xhrUrls.get(this);
  if (url) {
    this.addEventListener("load", () => {
      if (xhrUrls.get(this) !== url) return;
      try {
        if (this.status >= 200 && this.status < 300 && typeof this.responseText === "string") {
          postCaptionResponse(url, this.responseText);
        }
      } catch {
        /* responseText can throw for non-text responseType */
      }
    }, { once: true });
  }
  return Reflect.apply(originalSend, this, [body]) as void;
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await originalFetch(input, init);
  const url = response.url || captionUrl(input);
  if (response.ok && isYoutubeCaptionUrl(url)) {
    void response.clone().text()
      .then((body) => postCaptionResponse(url, body))
      .catch(() => {});
  }
  return response;
};

export {};
