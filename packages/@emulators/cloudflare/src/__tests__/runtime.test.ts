import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import type { Readable } from "node:stream";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the real Worker and Durable Object in workerd and records everything
// Cloudflare could: every tail event (the source of Workers Logs and Issues,
// including uncaught exception events), workerd's own stdout and stderr, and
// the Analytics Engine data points the code writes. Faults are injected at the
// storage and stub boundaries with synthetic secrets in the message, the error
// name and the instance URL; none may reach any of it.
const SECRET = "SYNTHETICtoken482913";
const SUFFIX = "0123456789abcdef01234567";
const INSTANCE = `synthetic-${SUFFIX}`;
const SECRETS = [SECRET, SUFFIX];
const POINT = "probe:analytics-engine";

// The probe module wraps the shipped exports. Its Durable Object hands the real
// one a storage proxy that fails the way `x-probe-fault` asks, and its Worker
// can swap in a namespace whose addressing or stub fails. Both get a FAILURES
// dataset that reports each data point as a tagged log line, so the tail sees
// exactly what Analytics Engine would store.
const PROBE = `
import worker, { EmulatorDurableObject } from "./worker.ts";
const FAILURES = { writeDataPoint: (point) => console.log("${POINT}", JSON.stringify(point)) };
const secretError = (flags) =>
  Object.assign(new Error("uncaught ${SECRET} https://resend.${INSTANCE}.emulators.dev/emails"), { name: "${SECRET}" }, flags);
export class ProbeObject extends EmulatorDurableObject {
  constructor(state, env) {
    let fault = null;
    const storage = new Proxy(state.storage, {
      get(target, key) {
        if (fault === "do-flagged" && key === "get") return async () => { throw secretError({ retryable: true }); };
        if (fault === "do-plain" && key === "get") return async () => { throw secretError({}); };
        if (fault === "do-put" && key === "put") return async () => { throw secretError({}); };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super({ storage, blockConcurrencyWhile: state.blockConcurrencyWhile.bind(state) }, { ...env, FAILURES });
    this.setFault = (next) => { fault = next; };
  }
  async fetch(request) {
    this.setFault(request.headers.get("x-probe-fault"));
    return super.fetch(request);
  }
}
export default {
  fetch(request, env) {
    env = { ...env, FAILURES };
    const fault = request.headers.get("x-probe-fault");
    if (fault === "worker-id")
      env = { ...env, EMULATOR: { idFromName() { throw secretError({}); }, get: () => env.EMULATOR.get() } };
    if (fault === "worker-stub")
      env = { ...env, EMULATOR: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw secretError({ retryable: true, overloaded: true }); } }) } };
    if (fault === "worker-env")
      env = { FAILURES, get EMULATE_HOST_SUFFIX() { throw secretError({}); } };
    return worker.fetch(request, env);
  },
};
`;

interface TailEvent {
  outcome: string;
  event?: { request?: { url: string; headers: Record<string, string> } };
  entrypoint?: string;
  exceptions: Array<{ name: string; message: string; stack?: string }>;
  logs: Array<{ level: string; message: unknown[] }>;
}

let mf: Miniflare;
const tailed: TailEvent[] = [];
const runtimeOutput: string[] = [];

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: PROBE, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    logLevel: "silent",
    plugins: [
      {
        name: "node-builtins",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            isBuiltin(args.path) ? { path: `node:${args.path.replace(/^node:/, "")}`, external: true } : undefined,
          );
        },
      },
    ],
  });
  mf = new Miniflare({
    log: new Log(LogLevel.NONE),
    handleRuntimeStdio(stdout: Readable, stderr: Readable) {
      stdout.on("data", (chunk: Buffer) => runtimeOutput.push(String(chunk)));
      stderr.on("data", (chunk: Buffer) => runtimeOutput.push(String(chunk)));
    },
    workers: [
      {
        name: "emulate-hosts",
        modules: [{ type: "ESModule", path: "/probe/worker.mjs", contents: bundle.outputFiles[0].text }],
        modulesRoot: "/probe",
        compatibilityDate: "2026-06-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { EMULATOR: "ProbeObject" },
        bindings: { EMULATE_HOST_SUFFIX: "emulators.dev" },
        tails: ["sink"],
      },
      {
        name: "sink",
        modules: true,
        script: `export default { async tail(events, env) { await env.CAPTURE.fetch("https://capture.invalid", { method: "POST", body: JSON.stringify(events) }); } };`,
        compatibilityDate: "2026-06-08",
        serviceBindings: {
          CAPTURE: async (request: Request) => {
            tailed.push(...((await request.json()) as TailEvent[]));
            return new Response("ok");
          },
        },
      },
    ],
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

async function waitForTail(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (tailed.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  // Late events (a second invocation, a trailing log) would land here.
  await new Promise((r) => setTimeout(r, 200));
}

const CASES: Array<{ fault: string; method?: string; path: string; status: number; report: Record<string, unknown> }> =
  [
    {
      fault: "do-flagged",
      path: "/emails",
      status: 503,
      report: { error: "emulator_unavailable", route: "/emails", retryable: true, errorClass: "other" },
    },
    {
      fault: "do-plain",
      path: "/emails",
      status: 500,
      report: { error: "emulator_error", route: "/emails", retryable: false, errorClass: "other" },
    },
    {
      fault: "do-put",
      method: "POST",
      path: "/_emulate/seed",
      status: 500,
      report: { error: "emulator_error", route: "/_emulate/seed", errorClass: "other" },
    },
    {
      fault: "do-put",
      method: "POST",
      path: "/_emulate/credentials",
      status: 500,
      report: { error: "emulator_error", route: "/_emulate/credentials", errorClass: "other" },
    },
    {
      fault: "worker-id",
      method: "POST",
      path: "/emails",
      status: 500,
      report: { error: "emulator_unavailable", route: "/emails", errorClass: "other" },
    },
    {
      fault: "worker-stub",
      path: "/emails",
      status: 503,
      report: { error: "emulator_unavailable", overloaded: true, errorClass: "other" },
    },
    {
      fault: "worker-env",
      path: "/emails",
      status: 500,
      report: { error: "worker_error", service: "unknown", instanceId: null },
    },
  ];

describe("emulate-hosts in workerd", () => {
  it("records no exception and no secret for any injected failure", async () => {
    const responses: string[] = [];
    for (const c of CASES) {
      const before = tailed.length;
      const response = await mf.dispatchFetch(`https://emulators.dev/resend/${INSTANCE}${c.path}`, {
        method: c.method ?? "GET",
        headers: { "x-probe-fault": c.fault, "content-type": "application/json" },
        body: c.method === "POST" ? JSON.stringify({ type: "api-key", login: "synthetic-user" }) : undefined,
      });
      const text = await response.text();
      responses.push(text);
      expect({ fault: c.fault, status: response.status }).toEqual({ fault: c.fault, status: c.status });
      expect(JSON.parse(text)).toMatchObject(c.report);
      // The Worker's invocation, plus the object's when the request reached it.
      await waitForTail(before + 1);
    }

    expect(tailed.length).toBeGreaterThanOrEqual(CASES.length);
    expect(tailed.map((event) => event.outcome).filter((outcome) => outcome !== "ok")).toEqual([]);
    expect(tailed.flatMap((event) => event.exceptions)).toEqual([]);
    // The code writes nothing to the console: every log line is a data point
    // from the probe's dataset, one per failure.
    const logged = tailed.flatMap((event) => event.logs.map((log) => log.message.map(String)));
    expect(logged.filter(([tag]) => tag !== POINT)).toEqual([]);
    const points = logged.map(([, point]) => JSON.parse(point) as { blobs: string[] });
    expect(points).toHaveLength(CASES.length);
    expect(points.map((point) => point.blobs[0]).sort()).toEqual(CASES.map((c) => c.report.error).sort());

    // The secret is nowhere: not in the complete tail events, the runtime's
    // output, the data points or the responses.
    const everything = [JSON.stringify(tailed), runtimeOutput.join(""), ...responses].join("\n");
    expect(everything).not.toContain(SECRET);
    // The instance name is only in the platform's own invocation metadata: the
    // Worker's request URL and the object's routing headers. That metadata is
    // what Workers Logs and Issues store with each record, which is why
    // observability is off (see the telemetry settings test in worker.test.ts).
    const carriers = new Set<string>();
    const visit = (value: unknown, path: string) => {
      if (typeof value === "string") {
        if (value.includes(SUFFIX)) carriers.add(path.replace(/^\d+\./, ""));
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
      }
    };
    tailed.forEach((event, i) => visit(event, String(i)));
    expect([...carriers].sort()).toEqual([
      "event.request.headers.x-emulator-base-url",
      "event.request.headers.x-emulator-instance",
      "event.request.url",
    ]);
    expect(SECRETS.filter((secret) => [runtimeOutput.join(""), ...responses].join("\n").includes(secret))).toEqual([]);
    expect(SECRETS.filter((secret) => JSON.stringify(points).includes(secret))).toEqual([]);
  }, 60_000);
});
