import type { RouteContext } from "@emulators/core";
import { authenticate, openaiError, requestHeaders } from "../common.js";
import { getOpenAIStore, type OpenAIModel } from "../store.js";

/**
 * GET /v1/models and GET /v1/models/{model}
 * (https://developers.openai.com/api/reference/resources/models/methods/list).
 * Lists the models seeded on the instance.
 */
function format(m: OpenAIModel) {
  return { id: m.model_id, object: "model", created: m.created, owned_by: m.owned_by };
}

export function modelRoutes({ app, store }: RouteContext): void {
  app.get("/v1/models", (c) => {
    c.set("operationId", "models.list");
    const caller = authenticate(store, c);
    if (caller instanceof Response) return caller;
    const data = getOpenAIStore(store)
      .models.all()
      .sort((a, b) => a.model_id.localeCompare(b.model_id))
      .map(format);
    return c.json({ object: "list", data }, 200, requestHeaders());
  });

  app.get("/v1/models/:model", (c) => {
    c.set("operationId", "models.retrieve");
    const caller = authenticate(store, c);
    if (caller instanceof Response) return caller;
    const m = getOpenAIStore(store).models.findOneBy("model_id", c.req.param("model"));
    if (!m) {
      return openaiError(
        c,
        404,
        `The model '${c.req.param("model")}' does not exist`,
        "invalid_request_error",
        "model_not_found",
        "model",
      );
    }
    return c.json(format(m), 200, requestHeaders());
  });
}
