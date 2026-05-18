import assert from "node:assert/strict";
import test from "node:test";
import { connectRuntime, selectRuntime, startRuntime } from "../src/harness.mjs";

test("selectRuntime defaults to the TypeScript runtime", () => {
  assert.equal(selectRuntime({}), "typescript");
  assert.equal(selectRuntime({ EMULATE_TARGET_URL: "http://127.0.0.1:4000" }), "external");
  assert.equal(selectRuntime({ EMULATE_SDK_RUNTIME: "go" }), "go");
});

test("connectRuntime returns an external target handle", async () => {
  const target = connectRuntime({ url: "http://127.0.0.1:65535/", service: "github" });
  assert.equal(target.runtime, "external");
  assert.equal(target.service, "github");
  assert.equal(target.baseUrl, "http://127.0.0.1:65535");
  assert.equal(target.child, null);
  await target.stop();
});

test("TypeScript runtime starts and serves the GitHub rate limit route", async (t) => {
  const target = await startRuntime({ runtime: "typescript", service: "github", readinessPath: "/rate_limit" });
  t.after(async () => {
    await target.stop();
  });

  const response = await fetch(new URL("/rate_limit", `${target.baseUrl}/`));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.rate.resource, "core");
  assert.equal(body.resources.core.limit, 5000);
});
