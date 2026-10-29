export const DEFAULT_SERVER_ORIGIN = "http://127.0.0.1:18791";
export const STORAGE_SERVER_ORIGIN = "babata.server_origin";
const SERVER_HEALTH_TIMEOUT_MS = 1200;
let clientIdPromise: Promise<string> | undefined;

// A routing identifier, not a credential. The lock makes simultaneous extension
// pages share one ID, including when the service worker restarts.
export function getBrowserClientId(): Promise<string> {
  return clientIdPromise ??= navigator.locks.request("babata.browser_client_id", async () => {
    const key = "babata.browser_client_id";
    const stored = await chrome.storage.session.get(key);
    if (typeof stored[key] === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(stored[key])) return stored[key] as string;
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ [key]: id });
    return id;
  }).then((id) => id).catch((error) => { clientIdPromise = undefined; throw error; });
}

export type TranslationProviderSettings = {
  base_url: string;
  model: string;
  api_key?: string;
  api_key_set?: boolean;
};

export type TranslationModelOption = {
  id: string;
  name?: string;
};

const LOCAL_SERVER_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;

export function parseServerOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const origin = url.origin;
    if (!LOCAL_SERVER_ORIGIN_RE.test(origin) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return origin;
  } catch {
    return null;
  }
}

export function normalizeServerOrigin(value: unknown): string {
  return parseServerOrigin(value) ?? DEFAULT_SERVER_ORIGIN;
}

export async function getServerOrigin(): Promise<string> {
  const got = await chrome.storage.local.get([STORAGE_SERVER_ORIGIN]);
  return normalizeServerOrigin(got[STORAGE_SERVER_ORIGIN]);
}

export async function setServerOrigin(origin: string): Promise<string> {
  const normalized = normalizeServerOrigin(origin);
  await navigator.locks.request("babata.server_origin", async () => {
    await chrome.storage.local.set({ [STORAGE_SERVER_ORIGIN]: normalized });
  });
  return normalized;
}

export function serverUrlFromOrigin(origin: string, path: string): string {
  const normalized = normalizeServerOrigin(origin);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}${suffix}`;
}

export async function companionHeaders(init?: HeadersInit): Promise<Headers> {
  const headers = new Headers(init);
  headers.set("x-babata-client-id", await getBrowserClientId());
  // Chromium can omit Origin on privileged extension GET requests. This
  // fallback cannot override the browser-supplied Origin on ordinary pages.
  headers.set("x-babata-extension-origin", `chrome-extension://${chrome.runtime.id}`);
  return headers;
}

export async function isServerOriginHealthy(origin: string, signal?: AbortSignal | null): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), SERVER_HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(serverUrlFromOrigin(origin, "/health"), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    return !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function resolveReachableServerOrigin(origin?: string, signal?: AbortSignal | null): Promise<string> {
  signal?.throwIfAborted();
  const preferred = normalizeServerOrigin(origin ?? await getServerOrigin());
  const healthy = await isServerOriginHealthy(preferred, signal);
  signal?.throwIfAborted();
  if (healthy) return preferred;
  if (preferred === DEFAULT_SERVER_ORIGIN) return preferred;
  const fallbackHealthy = await isServerOriginHealthy(DEFAULT_SERVER_ORIGIN, signal);
  signal?.throwIfAborted();
  if (fallbackHealthy) {
    await navigator.locks.request("babata.server_origin", async () => {
      signal?.throwIfAborted();
      // An old failed probe must not undo a newer explicit settings change.
      if (await getServerOrigin() === preferred) {
        signal?.throwIfAborted();
        await chrome.storage.local.set({ [STORAGE_SERVER_ORIGIN]: DEFAULT_SERVER_ORIGIN });
      }
    });
    return DEFAULT_SERVER_ORIGIN;
  }
  return preferred;
}

export async function serverUrl(path: string): Promise<string> {
  return serverUrlFromOrigin(await resolveReachableServerOrigin(), path);
}

export async function serverFetchFromOrigin(origin: string, path: string, init?: RequestInit): Promise<Response> {
  init?.signal?.throwIfAborted();
  const original = normalizeServerOrigin(origin);
  // Choose a server before dispatch. Never replay a POST after an ambiguous
  // network failure: the original server may already have accepted the action.
  const reachable = original === DEFAULT_SERVER_ORIGIN ? original : await resolveReachableServerOrigin(original, init?.signal);
  const headers = await companionHeaders(init?.headers);
  init?.signal?.throwIfAborted();
  return fetch(serverUrlFromOrigin(reachable, path), { ...init, headers });
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  return serverFetchFromOrigin(await getServerOrigin(), path, init);
}

export function wsUrlFromOrigin(origin: string, path = "/ws"): string {
  const url = new URL(serverUrlFromOrigin(origin, path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
