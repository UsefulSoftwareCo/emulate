import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";

import { contextPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

const PORT = 41893;
const BASE = `http://localhost:${PORT}`;

let httpServer: ReturnType<typeof serve>;

interface RetrieveResponse {
  partial: boolean;
  brand: { domain: string; title?: string; description?: string; logos?: unknown; colors?: unknown };
}

const retrieve = (body: unknown) =>
  fetch(`${BASE}/v1/brand/retrieve`, {
    method: "POST",
    headers: { authorization: "Bearer ctx_test_emulate", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const retrieveJson = async (body: unknown): Promise<RetrieveResponse> =>
  (await (await retrieve(body)).json()) as RetrieveResponse;

beforeAll(() => {
  const { app, store } = createServer(contextPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "ctx_emulate_admin", id: 1, scopes: [] },
  });
  seedFromConfig(store, BASE, {
    brands: [
      {
        domain: "acme.example",
        title: "Acme",
        description: "An example company.",
        logos: [{ url: "https://cdn.example/acme.png", type: "icon" }],
        colors: [{ hex: "#101010" }],
      },
      { domain: "Enriching.Example", title: "Enriching", partial: true },
    ],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
});

afterAll(() => {
  httpServer.close();
});

describe("brand/retrieve", () => {
  it("resolves a seeded company from a work email address", async () => {
    const response = await retrieve({ type: "by_email", email: "workspace@acme.example" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RetrieveResponse;
    expect(body.partial).toBe(false);
    expect(body.brand).toMatchObject({
      domain: "acme.example",
      title: "Acme",
      description: "An example company.",
      logos: [{ url: "https://cdn.example/acme.png", type: "icon" }],
      colors: [{ hex: "#101010" }],
    });
  });

  it("resolves the same company by domain", async () => {
    // A pasted website URL normalizes to the same domain key as the seed.
    const body = await retrieveJson({ type: "by_domain", domain: "https://www.Acme.example/pricing" });
    expect(body.brand.domain).toBe("acme.example");
    expect(body.brand.title).toBe("Acme");
  });

  it("returns 404 for a domain that was never seeded", async () => {
    const response = await retrieve({ type: "by_email", email: "someone@unknown.example" });
    expect(response.status).toBe(404);
  });

  it("rejects free and disposable mailbox domains without looking them up", async () => {
    for (const email of ["someone@gmail.com", "someone@outlook.com", "someone@mailinator.com"]) {
      const response = await retrieve({ type: "by_email", email });
      expect(response.status).toBe(404);
    }
  });

  it("flags a still-enriching profile as partial", async () => {
    const response = await retrieve({ type: "by_email", email: "workspace@enriching.example" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as RetrieveResponse).partial).toBe(true);
  });

  it("rejects a malformed address and an unsupported lookup type", async () => {
    expect((await retrieve({ type: "by_email", email: "not-an-address" })).status).toBe(422);
    expect((await retrieve({ type: "by_phone", phone: "555" })).status).toBe(422);
  });
});
