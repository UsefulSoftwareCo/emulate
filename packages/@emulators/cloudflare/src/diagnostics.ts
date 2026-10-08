import { createServer } from "@emulators/core";
import { SERVICES } from "./services.js";

// Failure reports go to the client and to Workers Logs, so every field is
// either a fixed value or chosen from a fixed list: no field copies text from
// the request or the error. The instance name is the sole access control for
// its emulator, request paths hold ids, emails and codes, and error messages,
// names and stacks can quote any of them. A report names the service from the
// registry, the instance by a short hash, the request by a route template the
// service's router declares, and the error by an allowlisted class name and
// Cloudflare's flags.
export interface FailureReport {
  error: "emulator_unavailable" | "emulator_error" | "worker_error";
  service: string;
  instanceId: string | null;
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
    instanceId: known ? await instanceId(request.service, request.instance) : null,
    method: METHODS.has(request.method) ? request.method : "OTHER",
    route: known ? routeTemplate(request.service, request.method, request.path) : "unmatched",
    errorClass: errorClass(cause),
    retryable: flags.retryable === true,
    overloaded: flags.overloaded === true,
    remote: flags.remote === true,
    ray: rayOf(request.headers),
  };
}

// The response for a failure at the Worker or Durable Object boundary: the
// report, logged once and returned as JSON. 503 when Cloudflare flags the
// failure retryable or overloaded, otherwise 500. Building it never throws, so
// no raw error escapes the boundary to Cloudflare's exception logging.
export async function failureResponse(
  error: FailureReport["error"],
  cause: unknown,
  request: Parameters<typeof failureReport>[2],
): Promise<Response> {
  let report: FailureReport;
  try {
    report = await failureReport(error, cause, request);
  } catch {
    report = {
      error,
      service: "unknown",
      instanceId: null,
      method: "OTHER",
      route: "unknown",
      errorClass: "other",
      retryable: false,
      overloaded: false,
      remote: false,
      ray: null,
    };
  }
  console.error(JSON.stringify(report));
  return Response.json(report, { status: report.retryable || report.overloaded ? 503 : 500 });
}

// Cloudflare raises its own runtime failures (a Durable Object that moved to a
// different machine, a lost connection, an overloaded object) as errors
// flagged `.retryable` or `.overloaded`.
// https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
export function isPlatformFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const flags = err as { retryable?: unknown; overloaded?: unknown };
  return flags.retryable === true || flags.overloaded === true;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const RAY = /^[0-9a-f]{16}(-[A-Z]{3})?$/;
// JavaScript's built-in error classes and the DOMException names the Workers
// runtime raises. Cloudflare's Durable Object failures are plain `Error`s told
// apart by their flags. Any other name, which code can set to anything, is
// reported as "other".
const ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DataCloneError",
  "QuotaExceededError",
  "InvalidStateError",
  "NetworkError",
  "OperationError",
]);

// The first 12 hex digits of SHA-256(`<service>:<instance>`), the Durable Object
// name; anyone holding the instance URL can compute it to find their reports.
// Generated instance names end in 96 random bits, so their hashes cannot be
// enumerated. The hash does not hide a predictable or low-entropy name (one a
// caller chose, or a legacy fixed name): hashing guesses confirms it.
export async function instanceId(service: string, instance: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${service}:${instance}`));
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

function errorClass(cause: unknown): string {
  const name = typeof cause === "object" && cause !== null ? (cause as { name?: unknown }).name : undefined;
  return typeof name === "string" && ERROR_CLASSES.has(name) ? name : "other";
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
