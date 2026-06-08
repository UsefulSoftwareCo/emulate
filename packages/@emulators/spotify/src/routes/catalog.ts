import type { RouteContext } from "@emulators/core";
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from "../entities.js";
import { getSpotifyStore, lookupToken } from "../store.js";

// The Web API catalog (the part Client Credentials can reach). A Bearer token
// issued by /api/token is required; user endpoints (/v1/me) are rejected because
// a client-credentials token has no user — a real Spotify behaviour.
export function catalogRoutes({ app, store, baseUrl }: RouteContext): void {
  const ss = getSpotifyStore(store);

  const authed = (c: { req: { header(n: string): string | undefined } }): boolean => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
    return !!m && !!lookupToken(store, m[1].trim());
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unauthorized = (c: any) => c.json({ error: { status: 401, message: "Invalid access token" } }, 401);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const notFound = (c: any) => c.json({ error: { status: 404, message: "Non existing id" } }, 404);

  const artistObj = (a: SpotifyArtist) => ({
    id: a.spotify_id,
    name: a.name,
    type: "artist",
    genres: a.genres,
    popularity: a.popularity,
    followers: { href: null, total: a.followers },
    uri: `spotify:artist:${a.spotify_id}`,
    href: `${baseUrl}/v1/artists/${a.spotify_id}`,
    external_urls: { spotify: `https://open.spotify.com/artist/${a.spotify_id}` },
  });
  const albumObj = (al: SpotifyAlbum) => {
    const ar = ss.artists.findOneBy("spotify_id", al.artist_id);
    return {
      id: al.spotify_id,
      name: al.name,
      type: "album",
      album_type: al.album_type,
      release_date: al.release_date,
      total_tracks: al.total_tracks,
      artists: ar ? [{ id: ar.spotify_id, name: ar.name, type: "artist", uri: `spotify:artist:${ar.spotify_id}` }] : [],
      uri: `spotify:album:${al.spotify_id}`,
      href: `${baseUrl}/v1/albums/${al.spotify_id}`,
      external_urls: { spotify: `https://open.spotify.com/album/${al.spotify_id}` },
    };
  };
  const trackObj = (t: SpotifyTrack) => {
    const al = ss.albums.findOneBy("spotify_id", t.album_id);
    const ar = ss.artists.findOneBy("spotify_id", t.artist_id);
    return {
      id: t.spotify_id,
      name: t.name,
      type: "track",
      duration_ms: t.duration_ms,
      popularity: t.popularity,
      track_number: t.track_number,
      explicit: false,
      album: al ? { id: al.spotify_id, name: al.name, uri: `spotify:album:${al.spotify_id}` } : null,
      artists: ar ? [{ id: ar.spotify_id, name: ar.name, type: "artist" }] : [],
      uri: `spotify:track:${t.spotify_id}`,
      external_urls: { spotify: `https://open.spotify.com/track/${t.spotify_id}` },
    };
  };

  app.get("/v1/search", (c) => {
    if (!authed(c)) return unauthorized(c);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const types = (c.req.query("type") ?? "artist,album,track").split(",").map((s) => s.trim());
    const m = (name: string) => (q ? name.toLowerCase().includes(q) : true);
    const out: Record<string, unknown> = {};
    if (types.includes("artist")) out.artists = { items: ss.artists.all().filter((a) => m(a.name)).map(artistObj) };
    if (types.includes("album")) out.albums = { items: ss.albums.all().filter((a) => m(a.name)).map(albumObj) };
    if (types.includes("track")) out.tracks = { items: ss.tracks.all().filter((t) => m(t.name)).map(trackObj) };
    return c.json(out);
  });

  app.get("/v1/artists/:id", (c) => {
    if (!authed(c)) return unauthorized(c);
    const a = ss.artists.findOneBy("spotify_id", c.req.param("id"));
    return a ? c.json(artistObj(a)) : notFound(c);
  });

  app.get("/v1/artists/:id/albums", (c) => {
    if (!authed(c)) return unauthorized(c);
    const items = ss.albums.findBy("artist_id", c.req.param("id")).map(albumObj);
    return c.json({ href: `${baseUrl}/v1/artists/${c.req.param("id")}/albums`, items, total: items.length });
  });

  app.get("/v1/albums/:id", (c) => {
    if (!authed(c)) return unauthorized(c);
    const al = ss.albums.findOneBy("spotify_id", c.req.param("id"));
    if (!al) return notFound(c);
    const items = ss.tracks.findBy("album_id", al.spotify_id).map(trackObj);
    return c.json({ ...albumObj(al), tracks: { items, total: items.length } });
  });

  app.get("/v1/tracks/:id", (c) => {
    if (!authed(c)) return unauthorized(c);
    const t = ss.tracks.findOneBy("spotify_id", c.req.param("id"));
    return t ? c.json(trackObj(t)) : notFound(c);
  });

  // A client-credentials token has no user → /v1/me is forbidden (real behaviour).
  app.get("/v1/me", (c) => {
    if (!authed(c)) return unauthorized(c);
    return c.json(
      { error: { status: 403, message: "This endpoint requires a user-authorized token; a client-credentials token has no user." } },
      403,
    );
  });
}
