// Thin client over the emulator worker. Production uses service and instance
// hosts (service.emulators.dev, service.instance.emulators.dev); local dev and
// workers.dev keep the path form (origin/service/instance).
import type { CatalogEntry, CoverageReport, LedgerEntry, ManifestResponse } from "./types";

export const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

const HOST_SUFFIX = "emulators.dev";

// The service host (e.g. github.emulators.dev) is itself a default, stateful
// instance. Named instances use the cert-safe path form on the apex.
export const DEFAULT_INSTANCE = "default";

const onEmulatorsHost = (): boolean => {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === HOST_SUFFIX || h.endsWith(`.${HOST_SUFFIX}`);
};

// The apex origin used to address named instances via the cert-safe path form
// (a 2-label instance subdomain has no Universal SSL certificate).
const apexOrigin = (): string => {
  if (typeof window === "undefined") return "";
  return onEmulatorsHost() ? `${window.location.protocol}//${HOST_SUFFIX}` : ORIGIN;
};

export interface HostRoute {
  service?: string;
  instance?: string;
}

/** Parse the service (and instance) the current host is scoped to, if any. */
export function hostRoute(): HostRoute {
  if (typeof window === "undefined") return {};
  const { hostname } = window.location;
  if (!hostname.endsWith(`.${HOST_SUFFIX}`)) return {};
  const prefix = hostname.slice(0, -(HOST_SUFFIX.length + 1));
  const labels = prefix.split(".").filter(Boolean);
  if (labels.length === 1) return { service: labels[0] };
  if (labels.length >= 2) return { service: labels[0], instance: labels[1] };
  return {};
}

export const hostService = (): string | null => hostRoute().service ?? null;

export const serviceHost = (service: string): string => {
  if (typeof window === "undefined") return "";
  const { protocol, hostname } = window.location;
  if (hostname === HOST_SUFFIX || hostname.endsWith(`.${HOST_SUFFIX}`)) {
    return `${protocol}//${service}.${HOST_SUFFIX}`;
  }
  return `${ORIGIN}/${service}`;
};

export const base = (service: string, instance: string): string => {
  if (typeof window === "undefined") return "";
  const route = hostRoute();
  // On this service's own host, talk same-origin: the service host is the default
  // instance, and a matching named-instance host serves itself.
  if (route.service === service && (!route.instance || route.instance === instance)) return ORIGIN;
  // Otherwise address via the cert-safe path form on the apex.
  return `${apexOrigin()}/${service}/${encodeURIComponent(instance)}`;
};

export const controlBase = (service: string, instance: string): string => `${base(service, instance)}/_emulate`;

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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

// Control-plane fetchers -------------------------------------------------------

export const fetchServices = (): Promise<{ services: CatalogEntry[] }> => getJson(`${ORIGIN}/_emulate/services`);

export const fetchManifest = (service: string, instance: string): Promise<ManifestResponse> =>
  getJson(`${controlBase(service, instance)}/manifest`);

export const fetchLedger = (service: string, instance: string, limit = 100): Promise<{ entries: LedgerEntry[] }> =>
  getJson(`${controlBase(service, instance)}/ledger?limit=${limit}`);

export const fetchState = (service: string, instance: string): Promise<unknown> =>
  getJson(`${controlBase(service, instance)}/state`);

export const fetchCoverage = (service: string, instance: string): Promise<CoverageReport> =>
  getJson(`${controlBase(service, instance)}/coverage`);

export const fetchLogs = (
  service: string,
  instance: string,
): Promise<{ webhooks: unknown[]; requests: LedgerEntry[] }> => getJson(`${controlBase(service, instance)}/logs`);

export async function postControl(service: string, instance: string, path: string, body?: unknown): Promise<ApiResult> {
  return api(`${controlBase(service, instance)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const randomInstance = (prefix = "run"): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

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
