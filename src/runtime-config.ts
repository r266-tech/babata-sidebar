export const DEFAULT_SERVER_ORIGIN = "http://127.0.0.1:18791";
export const STORAGE_SERVER_ORIGIN = "babata.server_origin";

export type TranslationProviderSettings = {
  base_url: string;
  model: string;
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

export async function serverUrl(path: string): Promise<string> {
  return serverUrlFromOrigin(await getServerOrigin(), path);
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(await serverUrl(path), init);
}

export function wsUrlFromOrigin(origin: string, path = "/ws"): string {
  const url = new URL(serverUrlFromOrigin(origin, path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
