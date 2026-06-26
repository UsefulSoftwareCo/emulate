import { requireAuth, type RouteContext } from "@emulators/core";

import { getPostHogStore } from "../store.js";

function parseProjectId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeProject(project: { project_id: number; name: string; api_token: string }): Record<string, unknown> {
  return {
    id: project.project_id,
    name: project.name,
    api_token: project.api_token,
  };
}

export function apiRoutes({ app, store }: RouteContext): void {
  const ps = getPostHogStore(store);

  app.get("/api/projects/", requireAuth(), (c) => {
    return c.json({ results: ps.projects.all().map(serializeProject) });
  });
  app.get("/api/projects", requireAuth(), (c) => {
    return c.redirect("/api/projects/", 307);
  });

  app.get("/api/projects/:project_id/events/", requireAuth(), (c) => {
    const projectId = parseProjectId(c.req.param("project_id"));
    if (projectId === null) return c.json({ detail: "Invalid project_id" }, 400);
    const results = ps.events
      .all()
      .filter((event) => event.project_id === projectId)
      .map((event) => ({
        id: event.id,
        event: event.event,
        distinct_id: event.distinct_id,
        properties: event.properties,
        timestamp: event.timestamp,
      }));
    return c.json({ results });
  });

  app.post("/api/projects/:project_id/events/", requireAuth(), async (c) => {
    const projectId = parseProjectId(c.req.param("project_id"));
    if (projectId === null) return c.json({ detail: "Invalid project_id" }, 400);
    if (!ps.projects.findOneBy("project_id", projectId)) return c.json({ detail: "Project not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const event = typeof body.event === "string" ? body.event : "";
    const distinctId = typeof body.distinct_id === "string" ? body.distinct_id : "";
    if (!event || !distinctId) return c.json({ detail: "event and distinct_id are required" }, 400);

    const inserted = ps.events.insert({
      project_id: projectId,
      event,
      distinct_id: distinctId,
      properties:
        body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
          ? (body.properties as Record<string, unknown>)
          : {},
      timestamp: typeof body.timestamp === "string" ? body.timestamp : new Date().toISOString(),
    });

    return c.json(
      {
        id: inserted.id,
        event: inserted.event,
        distinct_id: inserted.distinct_id,
        properties: inserted.properties,
        timestamp: inserted.timestamp,
      },
      201,
    );
  });

  app.get("/api/projects/:project_id/events", requireAuth(), (c) => {
    return c.redirect(`/api/projects/${c.req.param("project_id")}/events/`, 307);
  });

  app.get("/api/users/@me/", requireAuth(), (c) => {
    const authUser = c.get("authUser")!;
    const user = ps.users.findOneBy("email", authUser.login);
    return c.json({
      uuid: user?.uuid ?? `user_${authUser.id}`,
      distinct_id: authUser.login,
      email: authUser.login,
      first_name: user?.name.split(" ")[0] ?? null,
      is_staff: true,
    });
  });
  app.get("/api/users/@me", requireAuth(), (c) => {
    return c.redirect("/api/users/@me/", 307);
  });
}
