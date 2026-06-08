// Thin client over the emulator worker (same origin). Each emulator instance is
// addressed as `${origin}/<service>/<instance>`.
export const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

export const base = (service: string, instance: string): string => `${ORIGIN}/${service}/${encodeURIComponent(instance)}`;

export interface ApiResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}

export async function api(url: string, opts: RequestInit = {}): Promise<ApiResult> {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export const randomInstance = (prefix = "demo"): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

// Per-service instance id, remembered in localStorage.
export function loadInstance(service: string): string {
  const key = `emu.instance.${service}`;
  let v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (!v) {
    v = randomInstance();
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  }
  return v;
}
export function saveInstance(service: string, value: string): void {
  try {
    localStorage.setItem(`emu.instance.${service}`, value);
  } catch {
    /* ignore */
  }
}

// Generic JSON-in-localStorage (used to remember minted creds per instance).
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
