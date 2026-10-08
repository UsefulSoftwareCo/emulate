import { createServer } from "@emulators/core";
import { SERVICES } from "./services.js";

// Failure reports go to the client and to Workers Logs, so they carry only
// values that cannot hold a secret or user data. The instance name is the
// sole access control for its emulator, request paths hold ids, emails and
// codes, and error messages and stacks can quote any of them. A report names
// the instance by a short hash, the request by its route template, and the
// error by its class and Cloudflare's flags.
export interface FailureReport {
  error: "emulator_unavailable" | "emulator_error";
  service: string;
  instanceId: string;
  method: string;
  route: string;
  errorClass: string;
  retryable: boolean;
  overloaded: boolean;
  remote: boolean;
  ray: string | null;
}

export async function failureReport(
  error: FailureReport["error"],
  cause: unknown,
  request: { service: string; instance: string; method: string; path: string; headers: Headers },
): Promise<FailureReport> {
  const flags = (typeof cause === "object" && cause !== null ? cause : {}) as {
    retryable?: unknown;
    overloaded?: unknown;
    remote?: unknown;
  };
  const known = Object.hasOwn(SERVICES, request.service);
  return {
    error,
    service: known ? request.service : "unknown",
    instanceId: await instanceId(request.service, request.instance),
    method: METHOD.test(request.method) ? request.method : "OTHER",
    route: known ? routeTemplate(request.service, request.method, request.path) : "unmatched",
    errorClass: errorClass(cause),
    retryable: flags.retryable === true,
    overloaded: flags.overloaded === true,
    remote: flags.remote === true,
    ray: rayOf(request.headers),
  };
}

const METHOD = /^[A-Z]{1,10}$/;
const RAY = /^[0-9a-f]{16}(-[A-Z]{3})?$/;
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

// The first 12 hex digits of SHA-256(`<service>:<instance>`), the Durable Object
// name. Instance suffixes carry 96 random bits, so the hash cannot be reversed,
// and anyone holding the instance URL can compute it to find their reports.
export async function instanceId(service: string, instance: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${service}:${instance}`));
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

function errorClass(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : typeof cause;
  return ERROR_CLASS.test(name) ? name : "Unknown";
}

function rayOf(headers: Headers): string | null {
  const ray = headers.get("cf-ray");
  return ray && RAY.test(ray) ? ray : null;
}

// Paths the Durable Object serves itself, outside the service's router.
const OBJECT_ROUTES = new Set(["/__seed", "/__reset", "/__token"]);

// One route table per service and isolate, built only when a failure needs it:
// the routes are registered statically, so a throwaway server answers which
// pattern a path matches without touching any instance's state.
const routers = new Map<string, ReturnType<typeof createServer>["app"]>();

function routeTemplate(service: string, method: string, path: string): string {
  if (OBJECT_ROUTES.has(path)) return path;
  try {
    let app = routers.get(service);
    if (!app) {
      const entry = SERVICES[service];
      app = createServer(entry.plugin, { baseUrl: "https://route.invalid", manifest: entry.manifest }).app;
      routers.set(service, app);
    }
    return app.routePattern(method, path) ?? "unmatched";
  } catch {
    // A report must never fail on its way out; the template is a convenience.
    return "unknown";
  }
}
