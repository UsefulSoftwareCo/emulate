import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import type { ServicePlugin } from "../plugin.js";

const plugin: ServicePlugin = {
  name: "demo",
  register(app) {
    app.get("/me", (c) => {
      const user = c.get("authUser");
      return user ? c.json({ login: user.login }) : c.json({ message: "Requires authentication" }, 401);
    });
  },
};

const tokens = {
  tok_ada: { login: "ada", id: 1, scopes: [] },
  tok_bob: { login: "bob", id: 2, scopes: [] },
};
const me = (app: ReturnType<typeof createServer>["app"], token: string) =>
  app.request("/me", { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
const post = (app: ReturnType<typeof createServer>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("faults matched by a header", () => {
  it("faults only the caller whose Authorization matches, and every other caller passes", async () => {
    const { app } = createServer(plugin, { baseUrl: "http://localhost", tokens });
    const armed = await post(app, "/_emulate/faults", {
      match: { method: "GET", pathPattern: "/me", headers: { Authorization: "Bearer tok_ada" } },
      response: { status: 401, body: { message: "Bad credentials" } },
      times: 3,
    });
    expect(armed.status).toBe(200);
    expect(((await armed.json()) as { fault: { match: unknown } }).fault.match).toEqual({
      method: "GET",
      pathPattern: "/me",
      headers: { authorization: "Bearer tok_ada" },
    });
    expect([await me(app, "tok_bob"), await me(app, "tok_ada"), await me(app, "tok_bob")]).toEqual([200, 401, 200]);
    // The fault's remaining count is spent only by the matching caller.
    const faults = (await (await app.request("/_emulate/faults")).json()) as { faults: Array<{ remaining: number }> };
    expect(faults.faults[0]!.remaining).toBe(2);
  });

  it("refuses a malformed headers match", async () => {
    const { app } = createServer(plugin, { baseUrl: "http://localhost", tokens });
    for (const headers of [{}, { authorization: 5 }, ["authorization"]]) {
      const res = await post(app, "/_emulate/faults", {
        match: { pathPattern: "/me", headers },
        response: { status: 500 },
      });
      expect(res.status, JSON.stringify(headers)).toBe(400);
    }
  });
});

describe("revoking one token", () => {
  it("turns that token away and leaves the others working", async () => {
    const { app } = createServer(plugin, { baseUrl: "http://localhost", tokens });
    expect(await me(app, "tok_ada")).toBe(200);
    const revoked = await post(app, "/_emulate/tokens/revoke", { token: "tok_ada" });
    expect(revoked.status).toBe(200);
    expect([await me(app, "tok_ada"), await me(app, "tok_bob")]).toEqual([401, 200]);
    expect((await post(app, "/_emulate/tokens/revoke", { token: "tok_ada" })).status).toBe(404);
    expect((await post(app, "/_emulate/tokens/revoke", {})).status).toBe(400);
  });

  it("keeps a revoked token out where unknown tokens fall back to a default user", async () => {
    const { app } = createServer(plugin, {
      baseUrl: "http://localhost",
      tokens,
      fallbackUser: { login: "admin", id: 9, scopes: [] },
    });
    expect(await me(app, "anything")).toBe(200);
    await post(app, "/_emulate/tokens/revoke", { token: "tok_ada" });
    expect([await me(app, "tok_ada"), await me(app, "anything")]).toEqual([401, 200]);
  });

  it("asks the service to revoke a token it keeps in its own store", async () => {
    const own = new Set(["svc_tok"]);
    const service: ServicePlugin = {
      ...plugin,
      revokeToken: (_store, token) => own.delete(token),
    };
    const { app } = createServer(service, { baseUrl: "http://localhost" });
    expect((await post(app, "/_emulate/tokens/revoke", { token: "svc_tok" })).status).toBe(200);
    expect(own.has("svc_tok")).toBe(false);
  });
});
