/**
 * What `sonos_play` accepts: Spotify URIs and open.spotify.com links that Home Assistant's Sonos
 * integration turns into queue items. Artists are refused: Jarvis rewrote them to a Sonos-only
 * `artistTopTracks` URI, which HA's share-link handling is not known to support.
 */

export const MAX_URIS = 50;

const KINDS = ["track", "album", "playlist", "episode", "show"] as const;
const URI = /^spotify:([a-z]+):([A-Za-z0-9]+)$/i;
// Optional locale segment (`/intl-nl/`), then `/<kind>/<id>`; any query string (`?si=...`) is allowed.
const LINK_PATH = /^(?:\/intl-[a-z]{2}(?:[-_][a-z]{2})?)?\/([a-z]+)\/([A-Za-z0-9]+)\/?$/i;

function kindOf(uri: string): string | undefined {
  const m = URI.exec(uri);
  if (m) return m[1].toLowerCase();
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "open.spotify.com") return undefined;
  return LINK_PATH.exec(url.pathname)?.[1].toLowerCase();
}

/** Check every URI before anything is played; returns them trimmed, in order. */
export function checkUris(uris: unknown): string[] {
  if (!Array.isArray(uris) || uris.length === 0) throw new Error("Give at least one Spotify URI or link to play");
  if (uris.length > MAX_URIS) throw new Error(`At most ${MAX_URIS} URIs can be queued at once`);
  return uris.map((u) => {
    if (typeof u !== "string") throw new Error("URIs must be strings");
    const uri = u.trim();
    const kind = kindOf(uri);
    if (kind === "artist" || /^spotify:artist/i.test(uri)) {
      throw new Error(`"${uri}" is a Spotify artist, which can't be played directly. Play the artist's tracks, an album or a playlist instead.`);
    }
    if (!kind || !(KINDS as readonly string[]).includes(kind)) {
      throw new Error(`"${uri}" is not a Spotify track, album, playlist, episode or show URI or open.spotify.com link`);
    }
    return uri;
  });
}
