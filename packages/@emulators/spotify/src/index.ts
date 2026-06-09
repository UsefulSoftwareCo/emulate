import type { RouteContext, ServicePlugin, Store } from "@emulators/core";
import { getSpotifyStore, spotifyId } from "./store.js";
import { appsRoutes, tokenRoutes } from "./routes/token.js";
import { catalogRoutes } from "./routes/catalog.js";
import { openapiRoutes } from "./routes/openapi.js";

export { getSpotifyStore, type SpotifyStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export interface SpotifySeedConfig {
  clients?: Array<{ client_id: string; client_secret: string; name?: string }>;
  artists?: Array<{
    name: string;
    genres?: string[];
    popularity?: number;
    followers?: number;
    albums?: Array<{ name: string; release_date?: string; tracks?: Array<{ name: string; duration_ms?: number }> }>;
  }>;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: SpotifySeedConfig): void {
  const ss = getSpotifyStore(store);
  for (const c of config.clients ?? []) {
    if (!ss.clients.findOneBy("client_id", c.client_id)) {
      ss.clients.insert({ client_id: c.client_id, client_secret: c.client_secret, name: c.name ?? c.client_id });
    }
  }
  for (const a of config.artists ?? []) {
    let artist = ss.artists.findOneBy("name", a.name);
    if (!artist) {
      artist = ss.artists.insert({
        spotify_id: spotifyId(),
        name: a.name,
        genres: a.genres ?? [],
        popularity: a.popularity ?? 50,
        followers: a.followers ?? 1000,
      });
    }
    for (const al of a.albums ?? []) {
      const album = ss.albums.insert({
        spotify_id: spotifyId(),
        name: al.name,
        artist_id: artist.spotify_id,
        album_type: "album",
        release_date: al.release_date ?? "2020-01-01",
        total_tracks: (al.tracks ?? []).length,
      });
      let n = 1;
      for (const t of al.tracks ?? []) {
        ss.tracks.insert({
          spotify_id: spotifyId(),
          name: t.name,
          album_id: album.spotify_id,
          artist_id: artist.spotify_id,
          duration_ms: t.duration_ms ?? 200000,
          popularity: 50,
          track_number: n++,
        });
      }
    }
  }
}

export const spotifyPlugin: ServicePlugin = {
  name: "spotify",
  register(app, store, webhooks, baseUrl, tokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    appsRoutes(ctx);
    tokenRoutes(ctx);
    catalogRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(store, baseUrl): void {
    seedFromConfig(store, baseUrl, {
      clients: [{ client_id: "demo-client-id", client_secret: "demo-client-secret", name: "Demo App" }],
      artists: [
        {
          name: "Daft Punk",
          genres: ["electronic", "french house"],
          popularity: 88,
          followers: 9_000_000,
          albums: [
            {
              name: "Discovery",
              release_date: "2001-03-12",
              tracks: [
                { name: "One More Time" },
                { name: "Harder, Better, Faster, Stronger" },
                { name: "Digital Love" },
              ],
            },
          ],
        },
        {
          name: "Tame Impala",
          genres: ["psychedelic rock"],
          popularity: 85,
          followers: 6_000_000,
          albums: [
            {
              name: "Currents",
              release_date: "2015-07-17",
              tracks: [{ name: "Let It Happen" }, { name: "The Less I Know the Better" }],
            },
          ],
        },
      ],
    });
  },
};

export default spotifyPlugin;
