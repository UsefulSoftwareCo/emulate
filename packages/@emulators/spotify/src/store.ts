import { Store, type Collection } from "@emulators/core";
import type { SpotifyArtist, SpotifyAlbum, SpotifyClient, SpotifyTrack } from "./entities.js";

export interface SpotifyStore {
  clients: Collection<SpotifyClient>;
  artists: Collection<SpotifyArtist>;
  albums: Collection<SpotifyAlbum>;
  tracks: Collection<SpotifyTrack>;
}

export function getSpotifyStore(store: Store): SpotifyStore {
  return {
    clients: store.collection<SpotifyClient>("spotify.clients", ["client_id"]),
    artists: store.collection<SpotifyArtist>("spotify.artists", ["spotify_id", "name"]),
    albums: store.collection<SpotifyAlbum>("spotify.albums", ["spotify_id", "artist_id"]),
    tracks: store.collection<SpotifyTrack>("spotify.tracks", ["spotify_id", "album_id", "artist_id"]),
  };
}

// Spotify-style 22-char base62 id.
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function spotifyId(): string {
  const b = new Uint8Array(22);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => B62[x % 62]).join("");
}

// Issued client-credentials tokens, kept in the snapshot-safe store data map
// (NOT the core tokenMap, which isn't persisted across DO eviction).
export interface IssuedToken {
  clientId: string;
  scopes: string[];
}
const KEY = "spotify.tokens";
export function issueToken(store: Store, token: string, rec: IssuedToken): void {
  const m = store.getData<Record<string, IssuedToken>>(KEY) ?? {};
  m[token] = rec;
  store.setData(KEY, m);
}
export function lookupToken(store: Store, token: string): IssuedToken | undefined {
  return (store.getData<Record<string, IssuedToken>>(KEY) ?? {})[token];
}
