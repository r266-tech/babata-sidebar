const BBT_YT_CAPTION_MESSAGE = "babata.youtube_caption_response";

function captionUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isYoutubeCaptionUrl(url: string): boolean {
  if (!url) return false;
  return /\/api\/timedtext\b/.test(url)
    || /[?&]fmt=json3\b/.test(url)
    || /[?&]kind=asr\b/.test(url);
}

function postCaptionResponse(url: string, response: string) {
  if (!response || response.length > 2_000_000) return;
  window.postMessage({
    source: "babata-youtube-subtitles-main",
    type: BBT_YT_CAPTION_MESSAGE,
    url,
    response,
  }, "*");
}

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
  return Reflect.apply(originalOpen, this, [method, url, async, username, password]) as void;
};

XMLHttpRequest.prototype.send = function send(body?: XMLHttpRequestBodyInit | null) {
  const url = xhrUrls.get(this);
  if (url) {
    this.addEventListener("load", () => {
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
  if (isYoutubeCaptionUrl(url)) {
    void response.clone().text()
      .then((body) => postCaptionResponse(url, body))
      .catch(() => {});
  }
  return response;
};

export {};
