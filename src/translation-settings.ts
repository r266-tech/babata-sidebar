export type TranslationMode = "off" | "bilingual" | "replace";
export type TranslationRenderMode = Exclude<TranslationMode, "off">;

export const STORAGE_TRANSLATION_MODE = "babata.translation_mode";
export const STORAGE_SELECTION_TRANSLATION = "babata.selection_translation_enabled";
export const STORAGE_ALWAYS_TRANSLATE_HOSTS = "babata.translation_always_hosts";
export const STORAGE_ALWAYS_TRANSLATE_DISABLED_HOSTS = "babata.translation_always_disabled_hosts";
export const DEFAULT_TRANSLATION_RENDER_MODE: TranslationRenderMode = "replace";
export const DEFAULT_ALWAYS_TRANSLATE_HOST_ENABLED = true;

export function normalizeTranslationRenderMode(v: unknown): TranslationRenderMode {
  if (v === "bilingual") return "bilingual";
  if (v === "auto" || v === "off" || v === "replace") return "replace";
  return DEFAULT_TRANSLATION_RENDER_MODE;
}

export function normalizeTranslationMode(v: unknown): TranslationMode {
  if (v === "off") return "off";
  return normalizeTranslationRenderMode(v);
}

export function normalizeHostname(hostname: unknown): string {
  if (typeof hostname !== "string") return "";
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

export function hostnameFromUrl(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return "";
  }
}

export function normalizeHostList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const host = normalizeHostname(item);
    if (host) seen.add(host);
  }
  return Array.from(seen).sort();
}

export function isAlwaysTranslateHost(
  hosts: unknown,
  hostname: unknown,
  disabledHosts: unknown = [],
): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (normalizeHostList(disabledHosts).includes(host)) return false;
  return normalizeHostList(hosts).includes(host) || DEFAULT_ALWAYS_TRANSLATE_HOST_ENABLED;
}

export function updateAlwaysTranslateHostState(
  hosts: unknown,
  disabledHosts: unknown,
  hostname: unknown,
  enabled: boolean,
): { hosts: string[]; disabledHosts: string[] } {
  const current = normalizeHostList(hosts);
  const disabled = normalizeHostList(disabledHosts);
  const host = normalizeHostname(hostname);
  if (!host) return { hosts: current, disabledHosts: disabled };
  if (enabled) {
    return {
      hosts: normalizeHostList([...current, host]),
      disabledHosts: disabled.filter((item) => item !== host),
    };
  }
  return {
    hosts: current.filter((item) => item !== host),
    disabledHosts: normalizeHostList([...disabled, host]),
  };
}

export function effectiveTranslationModeForHost(
  baseMode: unknown,
  alwaysHosts: unknown,
  hostname: unknown,
  disabledHosts: unknown = [],
): TranslationMode {
  const host = normalizeHostname(hostname);
  if (host && normalizeHostList(disabledHosts).includes(host)) return "off";
  if (isAlwaysTranslateHost(alwaysHosts, hostname, disabledHosts)) {
    return normalizeTranslationRenderMode(baseMode);
  }
  return "off";
}

export function effectiveTranslationModeForUrl(
  baseMode: unknown,
  alwaysHosts: unknown,
  url: string,
  disabledHosts: unknown = [],
): TranslationMode {
  return effectiveTranslationModeForHost(baseMode, alwaysHosts, hostnameFromUrl(url), disabledHosts);
}
