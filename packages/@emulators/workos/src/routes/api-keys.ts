import type { RouteContext } from "@emulators/core";

import { getWorkosStore } from "../store.js";
import { serializeApiKey, workosError } from "../helpers.js";

export function apiKeyRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = () => getWorkosStore(store);

  // The SDK's apiKeys.validateApiKey → POST /api_keys/validations
  app.post("/api_keys/validations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const value = String(body.value ?? "");
    const key = ws().apiKeys.findOneBy("value", value);
    // Real WorkOS answers an unrecognized value with 200 { api_key: null } — it
    // does NOT 404 (confirmed against api.workos.com). The distinction matters
    // downstream: a 404 makes the SDK throw, which a caller reading it as an
    // api-key gate renders as a validation *outage* (503) rather than a clean
    // "not a valid key" (401). Mirror the real wire so that boundary is faithful.
    if (!key) return c.json({ api_key: null });
    ws().apiKeys.update(key.id, { last_used_at: new Date().toISOString() });
    return c.json({ api_key: serializeApiKey(key) });
  });

  app.delete("/api_keys/:id", (c) => {
    const key = ws().apiKeys.findOneBy("workos_id", c.req.param("id"));
    if (!key) return workosError(c, 404, "entity_not_found", "API key not found.");
    ws().apiKeys.delete(key.id);
    return c.body(null, 204);
  });
}
