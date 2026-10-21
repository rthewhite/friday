/** search_spotify and list_spotify_playlists, mapped to compact results (names and URIs, no images or markets). */
import { Type, type ModuleContext } from "@friday/sdk";
import type { SpotifyGet } from "./spotify.js";

export const PROVIDER = "spotify";
export const SEARCH_LIMIT = 10;
export const PLAYLIST_LIMIT = 50;

interface Named { name: string; uri: string }
interface SpotifyArtist extends Named {}
interface SpotifyAlbum extends Named { artists?: SpotifyArtist[]; release_date?: string }
interface SpotifyTrack extends Named { artists?: SpotifyArtist[]; album?: SpotifyAlbum }
interface SearchResponse {
  tracks?: { items?: (SpotifyTrack | null)[] };
  artists?: { items?: (SpotifyArtist | null)[] };
  albums?: { items?: (SpotifyAlbum | null)[] };
}
interface SpotifyPlaylist extends Named {
  description?: string | null;
  owner?: { id?: string; display_name?: string | null };
  /** Current name of the item count; `tracks` is the deprecated one. */
  items?: { total?: number };
  tracks?: { total?: number };
}
interface PlaylistsResponse { items?: (SpotifyPlaylist | null)[] }

export interface TrackResult { name: string; artist?: string; album?: string; uri: string }
export interface ArtistResult { name: string; uri: string }
export interface AlbumResult { name: string; artist?: string; year?: string; uri: string }
export interface PlaylistResult { name: string; description?: string; owner?: string; tracks?: number; uri: string }

const present = <T>(xs: (T | null)[] | undefined): T[] => (xs ?? []).filter((x): x is T => x !== null && x !== undefined);
const firstArtist = (a: SpotifyArtist[] | undefined) => a?.[0]?.name;

export function mapSearch(r: SearchResponse) {
  return {
    tracks: present(r.tracks?.items).map((t): TrackResult => ({
      name: t.name,
      ...(firstArtist(t.artists) && { artist: firstArtist(t.artists) }),
      ...(t.album?.name && { album: t.album.name }),
      uri: t.uri,
    })),
    artists: present(r.artists?.items).map((a): ArtistResult => ({ name: a.name, uri: a.uri })),
    albums: present(r.albums?.items).map((a): AlbumResult => ({
      name: a.name,
      ...(firstArtist(a.artists) && { artist: firstArtist(a.artists) }),
      ...(a.release_date && { year: a.release_date.slice(0, 4) }),
      uri: a.uri,
    })),
  };
}

export function mapPlaylists(r: PlaylistsResponse): PlaylistResult[] {
  return present(r.items).map((p) => {
    const owner = p.owner?.display_name || p.owner?.id;
    const tracks = p.items?.total ?? p.tracks?.total;
    return {
      name: p.name,
      ...(p.description?.trim() && { description: p.description.trim() }),
      ...(owner && { owner }),
      ...(tracks !== undefined && { tracks }),
      uri: p.uri,
    };
  });
}

export function defineSpotifyTools(ctx: ModuleContext, get: SpotifyGet): void {
  // Asked for on every call: grants, revokes and reconnects apply at once, and the token is refreshed when due.
  // A rejection is an OAuthError whose message already tells the user what to do under Settings > Connections.
  const token = () => ctx.oauth.token(PROVIDER);

  ctx.defineTool<{ query: string }>({
    name: "search_spotify",
    description:
      "Search Spotify for tracks, artists and albums, returning their names and Spotify URIs. " +
      "For finding things and their URIs only: this tool does not play music. To play something, pass its URI to a playback tool.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: "What to look for: a song, artist or album name" } },
      required: ["query"],
    },
    handler: async ({ query }) => {
      const q = typeof query === "string" ? query.trim() : "";
      if (!q) throw new Error("Give something to search Spotify for.");
      const params = new URLSearchParams({ q, type: "track,artist,album", limit: String(SEARCH_LIMIT) });
      return mapSearch(await get<SearchResponse>(`/search?${params}`, await token()));
    },
  });

  ctx.defineTool({
    name: "list_spotify_playlists",
    description: "List the user's Spotify playlists, their own and the ones they follow, with owners, track counts and URIs.",
    handler: async () => ({ playlists: mapPlaylists(await get<PlaylistsResponse>(`/me/playlists?limit=${PLAYLIST_LIMIT}`, await token())) }),
  });
}
