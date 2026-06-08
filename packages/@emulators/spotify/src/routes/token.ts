import { bodyStr, constantTimeSecretEqual, type RouteContext } from "@emulators/core";
import { getSpotifyStore, issueToken, spotifyId } from "../store.js";

// Real Spotify hands you client_id/secret in its developer dashboard; the
// emulator has no dashboard, so this is its stand-in: create an "app" and get
// back working credentials. Provide your own id/secret or let it generate them.
export function appsRoutes({ app, store, baseUrl }: RouteContext): void {
  const ss = getSpotifyStore(store);
  // List the apps (clients) created on this instance — the console renders them.
  app.get("/_emulator/apps", (c) =>
    c.json({
      apps: ss.clients.all().map((cl) => ({ client_id: cl.client_id, client_secret: cl.client_secret, name: cl.name })),
      token_url: `${baseUrl}/api/token`,
    }),
  );
  app.post("/_emulator/apps", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const client_id = bodyStr(body.client_id) || `app_${spotifyId().slice(0, 18)}`;
    const client_secret = bodyStr(body.client_secret) || spotifyId();
    if (!ss.clients.findOneBy("client_id", client_id)) {
      ss.clients.insert({ client_id, client_secret, name: bodyStr(body.name) || "App" });
    }
    return c.json({ client_id, client_secret, token_url: `${baseUrl}/api/token`, grant_type: "client_credentials" });
  });
}

// Spotify's accounts token endpoint — Client Credentials grant. Real quirks:
//  • client auth via HTTP Basic header (base64 "client_id:client_secret"), or
//    client_id/client_secret in the form body;
//  • only grant_type=client_credentials here (no user, no refresh token);
//  • wrong creds → 401 invalid_client; wrong grant → 400 unsupported_grant_type.
export function tokenRoutes({ app, store }: RouteContext): void {
  const ss = getSpotifyStore(store);

  app.post("/api/token", async (c) => {
    const body = await c.req.parseBody();
    let clientId = bodyStr(body.client_id);
    let clientSecret = bodyStr(body.client_secret);

    const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
    if (basic) {
      try {
        const decoded = atob(basic[1].trim());
        const sep = decoded.indexOf(":");
        clientId = decoded.slice(0, sep);
        clientSecret = decoded.slice(sep + 1);
      } catch {
        /* fall through to invalid_client */
      }
    }

    if (bodyStr(body.grant_type) !== "client_credentials") {
      return c.json(
        { error: "unsupported_grant_type", error_description: "grant_type must be client_credentials" },
        400,
      );
    }

    const client = ss.clients.findOneBy("client_id", clientId);
    if (!client || !constantTimeSecretEqual(clientSecret, client.client_secret)) {
      return c.json({ error: "invalid_client", error_description: "Invalid client" }, 401);
    }

    const token = `BQ${spotifyId()}${spotifyId()}`;
    issueToken(store, token, { clientId, scopes: bodyStr(body.scope).split(" ").filter(Boolean) });
    return c.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
  });
}
