import type { RouteContext } from "@emulators/core";

// Serves an OpenAPI 3.1 document describing this emulator instance, pointed at
// itself (`servers[].url` = the instance base URL) with an OAuth2
// client-credentials security scheme bound to the emulator's own token endpoint.
// Useful for OpenAPI-aware clients and test tools.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Spotify Web API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Spotify Web API. OAuth 2.0 Client Credentials (app token, no user). Mint credentials via POST /_emulator/apps, then exchange them at the token endpoint.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        spotifyOAuth: {
          type: "oauth2",
          description: "Client Credentials — app-only token, no user context.",
          flows: {
            clientCredentials: {
              tokenUrl: `${baseUrl}/api/token`,
              scopes: {},
            },
          },
        },
      },
    },
    security: [{ spotifyOAuth: [] }],
    paths: {
      "/v1/search": {
        get: {
          operationId: "search",
          summary: "Search the catalog",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search query." },
            {
              name: "type",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Comma-separated item types: artist, album, track.",
            },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          ],
          responses: { "200": ok("Search results grouped by type.") },
        },
      },
      "/v1/artists/{id}": {
        get: {
          operationId: "getArtist",
          summary: "Get an artist",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Artist object.") },
        },
      },
      "/v1/artists/{id}/albums": {
        get: {
          operationId: "getArtistAlbums",
          summary: "Get an artist's albums",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Paged album list.") },
        },
      },
      "/v1/albums/{id}": {
        get: {
          operationId: "getAlbum",
          summary: "Get an album (with tracks)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Album object.") },
        },
      },
      "/v1/tracks/{id}": {
        get: {
          operationId: "getTrack",
          summary: "Get a track",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Track object.") },
        },
      },
      "/v1/me": {
        get: {
          operationId: "getCurrentUser",
          summary: "Get the current user (403 for app tokens — there is no user)",
          responses: { "403": ok("Client-credentials tokens have no user, faithfully to Spotify.") },
        },
      },
    },
  };
}
