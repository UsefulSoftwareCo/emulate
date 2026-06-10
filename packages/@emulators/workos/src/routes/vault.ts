import type { RouteContext } from "@emulators/core";

import { getWorkosStore } from "../store.js";
import {
  listEnvelope,
  randomToken,
  serializeVaultMetadata,
  serializeVaultObject,
  workosError,
  workosId,
} from "../helpers.js";

/** WorkOS Vault KV — the executor secret store's backend. */
export function vaultRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = () => getWorkosStore(store);

  app.post("/vault/v1/kv", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name ?? "");
    if (!name) return workosError(c, 400, "invalid_request", "name is required");
    if (ws().vaultObjects.findOneBy("name", name)) {
      return workosError(c, 409, "conflict", `An object named '${name}' already exists.`);
    }
    const object = ws().vaultObjects.insert({
      workos_id: workosId("kv"),
      name,
      value: String(body.value ?? ""),
      key_context: (body.key_context as Record<string, unknown>) ?? {},
      version_id: randomToken("version"),
    });
    return c.json(serializeVaultMetadata(object), 201);
  });

  app.get("/vault/v1/kv", (c) =>
    c.json(
      listEnvelope(
        ws()
          .vaultObjects.all()
          .map((object) => ({ id: object.workos_id, name: object.name })),
      ),
    ),
  );

  app.get("/vault/v1/kv/name/:name", (c) => {
    const object = ws().vaultObjects.findOneBy("name", c.req.param("name"));
    if (!object) return workosError(c, 404, "not_found", "Object not found.");
    return c.json(serializeVaultObject(object));
  });

  app.get("/vault/v1/kv/:id", (c) => {
    const object = ws().vaultObjects.findOneBy("workos_id", c.req.param("id"));
    if (!object) return workosError(c, 404, "not_found", "Object not found.");
    return c.json(serializeVaultObject(object));
  });

  app.put("/vault/v1/kv/:id", async (c) => {
    const object = ws().vaultObjects.findOneBy("workos_id", c.req.param("id"));
    if (!object) return workosError(c, 404, "not_found", "Object not found.");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const versionCheck = body.version_check;
    if (typeof versionCheck === "string" && versionCheck !== object.version_id) {
      return workosError(c, 409, "conflict", "Version check failed.");
    }
    const updated = ws().vaultObjects.update(object.id, {
      value: String(body.value ?? object.value),
      version_id: randomToken("version"),
    })!;
    return c.json(serializeVaultObject(updated));
  });

  app.delete("/vault/v1/kv/:id", (c) => {
    const object = ws().vaultObjects.findOneBy("workos_id", c.req.param("id"));
    if (!object) return workosError(c, 404, "not_found", "Object not found.");
    ws().vaultObjects.delete(object.id);
    return c.body(null, 204);
  });
}
