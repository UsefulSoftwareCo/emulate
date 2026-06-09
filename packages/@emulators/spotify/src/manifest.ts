import type { ServiceManifest } from "@emulators/core";

/**
 * Spotify's machine-readable service manifest. This is the single source of
 * truth for Spotify's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 *
 * Spotify is modelled as the canonical OAuth 2.0 Client Credentials provider:
 * an app-only token (no user), minted from a client_id/secret at the accounts
 * token endpoint, that reaches the public catalog. There is intentionally no
 * GraphQL or MCP surface because the real Spotify Web API does not expose them.
 */
export const manifest: ServiceManifest = {
  id: "spotify",
  name: "Spotify",
  description: "Stateful Spotify Web API emulator focused on client credentials OAuth and catalog APIs.",
  docsUrl: "https://docs.emulators.dev/spotify",
  surfaces: [
    {
      id: "token",
      kind: "oauth",
      title: "Client credentials token endpoint",
      status: "supported",
      basePath: "/api/token",
    },
    { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
  ],
  auth: [
    {
      id: "client-credentials",
      title: "OAuth client credentials",
      type: "oauth-client-credentials",
      status: "supported",
    },
  ],
  specs: [
    {
      kind: "openapi",
      title: "Spotify Web API subset",
      coverage: "hand-authored",
      url: "/openapi.json",
      operations: [
        {
          operationId: "token",
          method: "POST",
          path: "/api/token",
          status: "hand-authored",
          summary: "Client credentials grant — mint an app-only access token.",
        },
        {
          operationId: "search",
          method: "GET",
          path: "/v1/search",
          status: "hand-authored",
          summary: "Search the catalog for artists, albums, and tracks.",
        },
        {
          operationId: "getArtist",
          method: "GET",
          path: "/v1/artists/:id",
          status: "hand-authored",
        },
        {
          operationId: "getArtistAlbums",
          method: "GET",
          path: "/v1/artists/:id/albums",
          status: "hand-authored",
        },
        {
          operationId: "getAlbum",
          method: "GET",
          path: "/v1/albums/:id",
          status: "hand-authored",
          summary: "Get an album with its tracks.",
        },
        {
          operationId: "getTrack",
          method: "GET",
          path: "/v1/tracks/:id",
          status: "hand-authored",
        },
        {
          operationId: "getCurrentUserProfile",
          method: "GET",
          path: "/v1/me",
          status: "partial",
          summary: "Modelled to return 403 — a client-credentials token has no user, faithful to Spotify.",
        },
        {
          operationId: "getSeveralArtists",
          method: "GET",
          path: "/v1/artists",
          status: "unsupported",
        },
        {
          operationId: "getArtistTopTracks",
          method: "GET",
          path: "/v1/artists/:id/top-tracks",
          status: "unsupported",
        },
        {
          operationId: "getAlbumTracks",
          method: "GET",
          path: "/v1/albums/:id/tracks",
          status: "unsupported",
        },
        {
          operationId: "getRecommendations",
          method: "GET",
          path: "/v1/recommendations",
          status: "unsupported",
        },
        {
          operationId: "getPlaylist",
          method: "GET",
          path: "/v1/playlists/:id",
          status: "unsupported",
          summary: "Playlists are not seeded or served by the emulator.",
        },
      ],
    },
  ],
  seedSchema: {
    description: "Seed OAuth apps (clients) and a catalog of artists, albums, and tracks.",
    fields: [
      {
        key: "clients",
        title: "OAuth apps",
        description: "Client credentials addressable at the token endpoint.",
        example: [{ client_id: "demo-client-id", client_secret: "demo-client-secret", name: "Demo App" }],
      },
      {
        key: "artists",
        title: "Artists",
        description: "Catalog artists, each with optional nested albums and tracks.",
        example: [
          {
            name: "Daft Punk",
            genres: ["electronic", "french house"],
            popularity: 88,
            followers: 9000000,
            albums: [
              {
                name: "Discovery",
                release_date: "2001-03-12",
                tracks: [{ name: "One More Time", duration_ms: 320357 }, { name: "Digital Love" }],
              },
            ],
          },
        ],
      },
    ],
    example: {
      clients: [{ client_id: "demo-client-id", client_secret: "demo-client-secret", name: "Demo App" }],
      artists: [
        {
          name: "Tame Impala",
          genres: ["psychedelic rock"],
          popularity: 85,
          followers: 6000000,
          albums: [
            {
              name: "Currents",
              release_date: "2015-07-17",
              tracks: [{ name: "Let It Happen" }, { name: "The Less I Know the Better" }],
            },
          ],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities seeded and read by Spotify provider calls.",
    collections: [
      { name: "spotify.clients", title: "OAuth apps" },
      { name: "spotify.artists", title: "Artists" },
      { name: "spotify.albums", title: "Albums" },
      { name: "spotify.tracks", title: "Tracks" },
    ],
  },
  connections: [
    {
      id: "spotify-web-api-node",
      title: "spotify-web-api-node (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the Spotify SDK's account and API base hosts at the emulator instance.",
      template:
        'import SpotifyWebApi from "spotify-web-api-node";\n\nconst spotify = new SpotifyWebApi({\n  clientId: "{{clientId}}",\n  clientSecret: "{{clientSecret}}",\n});\n\n// Route both the accounts (token) and API hosts at the emulator.\nconst base = "{{baseUrl}}";\n\n// Client credentials grant against the emulator token endpoint.\nconst auth = Buffer.from("{{clientId}}:{{clientSecret}}").toString("base64");\nconst res = await fetch(`${base}/api/token`, {\n  method: "POST",\n  headers: {\n    authorization: `Basic ${auth}`,\n    "content-type": "application/x-www-form-urlencoded",\n  },\n  body: new URLSearchParams({ grant_type: "client_credentials" }),\n});\nconst { access_token } = await res.json();\nspotify.setAccessToken(access_token);\n\nconst results = await fetch(`${base}/v1/search?q=daft&type=artist`, {\n  headers: { authorization: `Bearer ${access_token}` },\n}).then((r) => r.json());',
    },
    {
      id: "spotify-env",
      title: "Spotify base URL (env)",
      kind: "env",
      language: "bash",
      description: "Point your app at the emulator instead of the real Spotify accounts and API hosts.",
      template:
        "SPOTIFY_BASE_URL={{baseUrl}}\nSPOTIFY_TOKEN_URL={{baseUrl}}/api/token\nSPOTIFY_CLIENT_ID={{clientId}}\nSPOTIFY_CLIENT_SECRET={{clientSecret}}",
    },
    {
      id: "curl-token",
      title: "curl (client credentials)",
      kind: "curl",
      language: "bash",
      description: "Exchange client credentials for an app token, then call the catalog.",
      template:
        'curl -s -X POST {{baseUrl}}/api/token \\\n  -u "{{clientId}}:{{clientSecret}}" \\\n  -d grant_type=client_credentials',
    },
    {
      id: "curl-search",
      title: "curl (search)",
      kind: "curl",
      language: "bash",
      description: "Call the catalog directly with an app token.",
      template: 'curl -s "{{baseUrl}}/v1/search?q=daft&type=artist" -H "authorization: Bearer {{token}}"',
    },
  ],
};
