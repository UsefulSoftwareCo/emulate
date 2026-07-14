import type { RouteContext } from "@emulators/core";
import { requireGoogleAuth } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function searchConsoleRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/webmasters/v3/sites", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      siteEntry: gs.searchConsoleSites
        .all()
        .filter((site) => site.user_email === authEmail)
        .map((site) => ({
          siteUrl: site.site_url,
          permissionLevel: site.permission_level,
        })),
    });
  });
}
