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
    if (!key) return workosError(c, 404, "invalid_api_key", "API key is invalid.");
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
