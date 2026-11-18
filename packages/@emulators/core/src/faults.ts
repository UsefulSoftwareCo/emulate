import type { MiddlewareHandler } from "./http.js";
import type { LedgerEntry } from "./ledger.js";
import type { OperationCoverage, ServiceManifest } from "./manifest.js";
import type { AppEnv } from "./middleware/auth.js";

export interface FaultMatch {
  operationId?: string;
  method?: string;
  pathPattern?: string;
}

export interface FaultResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FaultArmInput {
  match: FaultMatch;
  response: FaultResponse;
  times?: number;
  delayMs?: number;
  /**
   * A caller-chosen key. Arming again with the same key and the same fault stores nothing and
   * returns the fault first stored for it, so a caller that lost an answer can send the same arm
   * again safely. The same key with a different fault is refused.
   */
  idempotencyKey?: string;
}

export interface ArmedFault {
  id: string;
  match: FaultMatch;
  response: FaultResponse;
  times: number;
  remaining: number;
  delayMs?: number;
  createdAt: string;
  idempotencyKey?: string;
}

/** The result of an arm: the fault, and whether a key named one stored by an earlier arm. */
export interface FaultArmResult {
  fault: ArmedFault;
  replayed: boolean;
}

/** An arm whose key was already used for a different fault. */
export class FaultKeyConflictError extends Error {}

/**
 * The fault each key armed, kept for as long as the registry's state: through consumption,
 * removal, clearing and reset. A key forgotten when its fault went away would let a late copy of
 * its arm store the fault again.
 */
export interface FaultKeyRecord {
  key: string;
  /** The arm's fault as stored (match normalized, `times` defaulted), in a canonical JSON form. */
  definition: string;
  fault: ArmedFault;
}

export interface FaultLedgerMarker {
  faulted: true;
  faultId: string;
}

/** Every armed fault and the next id, so a host can keep them across a restart. */
export interface FaultRegistrySnapshot {
  counter: number;
  faults: ArmedFault[];
  /** Absent in snapshots stored before keys existed. */
  keys?: FaultKeyRecord[];
}

export class FaultRegistry {
  private faults: ArmedFault[] = [];
  private counter = 1;
  private keys = new Map<string, FaultKeyRecord>();

  serialize(): FaultRegistrySnapshot {
    return {
      counter: this.counter,
      faults: this.faults.map(cloneFault),
      keys: [...this.keys.values()].map((record) => ({ ...record, fault: cloneFault(record.fault) })),
    };
  }

  restore(snapshot: FaultRegistrySnapshot | undefined): void {
    this.faults = (snapshot?.faults ?? []).map(cloneFault);
    this.counter = snapshot?.counter ?? 1;
    this.keys = new Map(
      (snapshot?.keys ?? []).map((record) => [record.key, { ...record, fault: cloneFault(record.fault) }]),
    );
  }

  arm(input: FaultArmInput): ArmedFault {
    return this.armOnce(input).fault;
  }

  /**
   * Arm a fault, or with a key already used for the same fault, return that key's fault (as it is
   * now, or with nothing remaining once it was consumed or removed) and store nothing. Checking
   * the key and storing happen in one synchronous step, so concurrent arms with a key cannot both
   * store.
   */
  armOnce(input: FaultArmInput): FaultArmResult {
    validateFaultInput(input);
    const definition: Omit<ArmedFault, "id" | "remaining" | "createdAt"> = {
      match: normalizeMatch(input.match),
      response: {
        status: input.response.status,
        ...(input.response.body === undefined ? {} : { body: input.response.body }),
        ...(input.response.headers ? { headers: input.response.headers } : {}),
      },
      times: input.times ?? 1,
      ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
    };
    const key = input.idempotencyKey;
    const canonical = key === undefined ? "" : canonicalJson(definition);
    if (key !== undefined) {
      const record = this.keys.get(key);
      if (record) {
        if (record.definition !== canonical) {
          throw new FaultKeyConflictError(`Fault idempotencyKey "${key}" was already used for a different fault.`);
        }
        const live = this.faults.find((fault) => fault.id === record.fault.id);
        return { fault: cloneFault(live ?? { ...record.fault, remaining: 0 }), replayed: true };
      }
    }
    const fault: ArmedFault = {
      id: `fault_${this.counter++}`,
      ...definition,
      remaining: definition.times,
      createdAt: new Date().toISOString(),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    };
    this.faults.push(fault);
    if (key !== undefined) this.keys.set(key, { key, definition: canonical, fault: cloneFault(fault) });
    return { fault: cloneFault(fault), replayed: false };
  }

  list(): ArmedFault[] {
    return this.faults.map(cloneFault);
  }

  clear(id?: string): boolean {
    if (id === undefined) {
      const hadFaults = this.faults.length > 0;
      this.faults.length = 0;
      return hadFaults;
    }
    const before = this.faults.length;
    this.faults = this.faults.filter((fault) => fault.id !== id);
    return this.faults.length !== before;
  }

  consume(request: FaultRequest): ArmedFault | null {
    const index = this.faults.findIndex((fault) => matchesFault(fault, request));
    if (index === -1) return null;
    const fault = this.faults[index]!;
    fault.remaining -= 1;
    if (fault.remaining <= 0) {
      this.faults.splice(index, 1);
    }
    return cloneFault({ ...fault, remaining: Math.max(0, fault.remaining) });
  }
}

export function createFaultMiddleware(
  faults: FaultRegistry,
  manifest: ServiceManifest,
  /**
   * Awaited after a request consumes a fault and before its delay, so a host that persists
   * faults stores the new count before a delayed response, which its caller may abandon.
   */
  onConsumed?: () => void | Promise<void>,
): MiddlewareHandler<AppEnv> {
  const operations = manifest.specs.flatMap((spec) => spec.operations ?? []);

  return async (c, next) => {
    if (c.req.path.startsWith("/_emulate")) {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    const operation = resolveOperation(operations, c.req.method, url.pathname);
    if (operation?.operationId) {
      c.set("operationId", operation.operationId);
    }

    const fault = faults.consume({
      operationId: operation?.operationId,
      method: c.req.method,
      path: url.pathname,
    });
    if (!fault) {
      await next();
      return;
    }

    c.set("fault", { faulted: true, faultId: fault.id });
    await onConsumed?.();
    if (fault.delayMs && fault.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    return faultResponse(fault.response);
  };
}

export function faultLedgerFields(c: {
  get: (key: "fault") => FaultLedgerMarker | undefined;
}): Pick<LedgerEntry, "faulted" | "faultId"> {
  const fault = c.get("fault");
  return fault ? { faulted: true, faultId: fault.faultId } : {};
}

interface FaultRequest {
  operationId?: string;
  method: string;
  path: string;
}

function validateFaultInput(input: FaultArmInput): void {
  if (!input || typeof input !== "object") throw new Error("Fault body is required.");
  if (!input.match || typeof input.match !== "object") throw new Error("Fault match is required.");
  if (!input.response || typeof input.response !== "object") throw new Error("Fault response is required.");
  if (!input.match.operationId && !input.match.method && !input.match.pathPattern) {
    throw new Error("Fault match must include operationId, method, or pathPattern.");
  }
  if (!Number.isInteger(input.response.status) || input.response.status < 100 || input.response.status > 599) {
    throw new Error("Fault response.status must be an HTTP status code.");
  }
  if (input.response.headers !== undefined) {
    if (
      !input.response.headers ||
      typeof input.response.headers !== "object" ||
      Array.isArray(input.response.headers)
    ) {
      throw new Error("Fault response.headers must be an object.");
    }
    for (const [key, value] of Object.entries(input.response.headers)) {
      if (typeof key !== "string" || typeof value !== "string") {
        throw new Error("Fault response.headers must contain string keys and values.");
      }
    }
  }
  if (input.times !== undefined && (!Number.isInteger(input.times) || input.times < 1)) {
    throw new Error("Fault times must be a positive integer.");
  }
  if (input.delayMs !== undefined && (!Number.isInteger(input.delayMs) || input.delayMs < 0)) {
    throw new Error("Fault delayMs must be a non-negative integer.");
  }
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255)
  ) {
    throw new Error("Fault idempotencyKey must be a string of 1 to 255 characters.");
  }
}

/** JSON with object keys sorted, so two copies of one fault compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );
}

function normalizeMatch(match: FaultMatch): FaultMatch {
  return {
    ...(match.operationId ? { operationId: match.operationId } : {}),
    ...(match.method ? { method: match.method.toUpperCase() } : {}),
    ...(match.pathPattern ? { pathPattern: match.pathPattern } : {}),
  };
}

function matchesFault(fault: ArmedFault, request: FaultRequest): boolean {
  if (fault.match.operationId && fault.match.operationId !== request.operationId) return false;
  if (fault.match.method && fault.match.method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (fault.match.pathPattern && !globToRegExp(fault.match.pathPattern).test(request.path)) return false;
  return true;
}

function resolveOperation(
  operations: OperationCoverage[],
  method: string,
  path: string,
): OperationCoverage | undefined {
  return operations.find((operation) => {
    if (!operation.method || !operation.path) return false;
    if (operation.method.toUpperCase() !== method.toUpperCase()) return false;
    return routePathToRegExp(operation.path).test(path);
  });
}

function routePathToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((part) => {
      if (part.startsWith(":") || (part.startsWith("{") && part.endsWith("}"))) return "[^/]+";
      return escapeRegExp(part);
    })
    .join("/");
  return new RegExp(`^${source}$`);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function faultResponse(response: FaultResponse): Response {
  const headers = new Headers(response.headers);
  if (response.body === undefined) {
    return new Response(null, { status: response.status, headers });
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const contentType = headers.get("content-type") ?? "";
  const body =
    contentType.includes("application/json") && typeof response.body !== "string"
      ? JSON.stringify(response.body)
      : String(response.body);
  return new Response(body, { status: response.status, headers });
}

function cloneFault(fault: ArmedFault): ArmedFault {
  return {
    ...fault,
    match: { ...fault.match },
    response: { ...fault.response, headers: fault.response.headers ? { ...fault.response.headers } : undefined },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
