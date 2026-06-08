import type { Entity } from "@emulators/core";

export interface SpotifyClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
}
export interface SpotifyArtist extends Entity {
  spotify_id: string;
  name: string;
  genres: string[];
  popularity: number;
  followers: number;
}
export interface SpotifyAlbum extends Entity {
  spotify_id: string;
  name: string;
  artist_id: string; // artist's spotify_id
  album_type: string;
  release_date: string;
  total_tracks: number;
}
export interface SpotifyTrack extends Entity {
  spotify_id: string;
  name: string;
  album_id: string; // album's spotify_id
  artist_id: string; // artist's spotify_id
  duration_ms: number;
  popularity: number;
  track_number: number;
}
