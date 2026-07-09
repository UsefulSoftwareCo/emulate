// Thin client over the emulator worker. Production uses service and instance
// hosts (service.emulators.dev, service.instance.emulators.dev); local dev and
// workers.dev keep the path form (origin/service/instance).
import type { CatalogEntry, CoverageReport, LedgerEntry, ManifestResponse } from "./types";

export const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

const HOST_SUFFIX = "emulators.dev";

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
  // A matching named-instance host serves itself same-origin. A bare service
  // host does not: it is control plane only (no shared default instance), so
  // instances are addressed via the cert-safe path form on the apex.
  if (route.service === service && route.instance === instance) return ORIGIN;
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

// The catalog is a static registry the worker inlines into the served HTML
// (window.__EMULATE_SERVICES__), so the console has it on first paint with no
// fetch. Read it synchronously; only fall back to the endpoint in dev.
export const injectedServices = (): CatalogEntry[] | null =>
  (typeof window !== "undefined" && window.__EMULATE_SERVICES__?.services) || null;

export const fetchServices = (): Promise<{ services: CatalogEntry[] }> => {
  const inlined = injectedServices();
  if (inlined) return Promise.resolve({ services: inlined });
  return getJson(`${ORIGIN}/_emulate/services`);
};

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

// The instance name is the only access control on hosted instances, so it must
// be unguessable: 96 bits of crypto randomness, matching the server-side
// generator in @emulators/core.
export const randomInstance = (prefix = "run"): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${suffix}`;
};

// Names generated before the crypto-random suffix (6 low-entropy chars). They
// are guessable, so they get regenerated rather than reused.
const LEGACY_WEAK_NAME = /^run-[a-z0-9]{6}$/;

// Per-service instance id, remembered in localStorage.
export function loadInstance(service: string): string {
  const key = `emu.instance.${service}`;
  let v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (!v || LEGACY_WEAK_NAME.test(v)) {
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
