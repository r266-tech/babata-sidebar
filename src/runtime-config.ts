export const DEFAULT_SERVER_ORIGIN = "http://127.0.0.1:18791";
export const STORAGE_SERVER_ORIGIN = "babata.server_origin";
const SERVER_HEALTH_TIMEOUT_MS = 1200;

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

export function normalizeServerOrigin(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SERVER_ORIGIN;
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_SERVER_ORIGIN;
  try {
    const url = new URL(raw);
    const origin = url.origin;
    if (!LOCAL_SERVER_ORIGIN_RE.test(origin)) return DEFAULT_SERVER_ORIGIN;
    return origin;
  } catch {
    return DEFAULT_SERVER_ORIGIN;
  }
}

export async function getServerOrigin(): Promise<string> {
  const got = await chrome.storage.local.get([STORAGE_SERVER_ORIGIN]);
  return normalizeServerOrigin(got[STORAGE_SERVER_ORIGIN]);
}

export async function setServerOrigin(origin: string): Promise<string> {
  const normalized = normalizeServerOrigin(origin);
  await chrome.storage.local.set({ [STORAGE_SERVER_ORIGIN]: normalized });
  return normalized;
}

export function serverUrlFromOrigin(origin: string, path: string): string {
  const normalized = normalizeServerOrigin(origin);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}${suffix}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = SERVER_HEALTH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function isServerOriginHealthy(origin: string): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(serverUrlFromOrigin(origin, "/health"), {
      method: "GET",
      cache: "no-store",
    });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    return !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export async function resolveReachableServerOrigin(origin?: string): Promise<string> {
  const preferred = normalizeServerOrigin(origin ?? await getServerOrigin());
  if (await isServerOriginHealthy(preferred)) return preferred;
  if (preferred === DEFAULT_SERVER_ORIGIN) return preferred;
  if (await isServerOriginHealthy(DEFAULT_SERVER_ORIGIN)) {
    await setServerOrigin(DEFAULT_SERVER_ORIGIN);
    return DEFAULT_SERVER_ORIGIN;
  }
  return preferred;
}

export async function serverUrl(path: string): Promise<string> {
  return serverUrlFromOrigin(await resolveReachableServerOrigin(), path);
}

export async function serverFetchFromOrigin(origin: string, path: string, init?: RequestInit): Promise<Response> {
  const original = normalizeServerOrigin(origin);
  if (original !== DEFAULT_SERVER_ORIGIN && !await isServerOriginHealthy(original)) {
    const fallback = await resolveReachableServerOrigin(original);
    if (fallback !== original) return fetch(serverUrlFromOrigin(fallback, path), init);
  }
  try {
    const resp = await fetch(serverUrlFromOrigin(original, path), init);
    if (resp.ok || original === DEFAULT_SERVER_ORIGIN || await isServerOriginHealthy(original)) {
      return resp;
    }
    const fallback = await resolveReachableServerOrigin(original);
    return fallback === original ? resp : fetch(serverUrlFromOrigin(fallback, path), init);
  } catch (error) {
    const fallback = await resolveReachableServerOrigin(original);
    if (fallback === original) throw error;
    return fetch(serverUrlFromOrigin(fallback, path), init);
  }
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  return serverFetchFromOrigin(await getServerOrigin(), path, init);
}

export function wsUrlFromOrigin(origin: string, path = "/ws"): string {
  const url = new URL(serverUrlFromOrigin(origin, path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
