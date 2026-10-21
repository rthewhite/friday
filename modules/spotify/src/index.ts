/**
 * Spotify search and playlists through the Spotify Web API (ported from the Jarvis Spotify tool). The module needs no
 * configuration: it requests the `spotify` OAuth connection, which the user sets up and grants it under
 * Settings > Connections. It loads either way; until then its tools fail with what to do.
 */
import { defineModule } from "@friday/sdk";
import { createSpotifyClient, type SpotifyClientOptions } from "./spotify.js";
import { defineSpotifyTools, PROVIDER } from "./tools.js";

export function createSpotifyModule(opts: SpotifyClientOptions = {}) {
  return defineModule({
    manifest: {
      id: "spotify",
      label: "Spotify",
      description: "Search Spotify and list your playlists.",
      oauth: [{
        provider: PROVIDER,
        scopes: ["playlist-read-private", "playlist-read-collaborative"],
        description: "Read your private and collaborative playlists",
      }],
    },
    init(ctx) {
      defineSpotifyTools(ctx, createSpotifyClient(opts));
    },
  });
}

export default createSpotifyModule();
