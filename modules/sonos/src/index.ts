/**
 * Sonos speakers through Home Assistant's Sonos integration (ported from the Jarvis Sonos tool).
 *
 * Config (declared in the manifest, read lazily through ctx.config):
 *   HA_URL, HA_TOKEN   Home Assistant base URL and long-lived access token (shared with the media module)
 */
import { defineModule, type ModuleContext } from "@friday/sdk";

export interface SonosOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createSonosModule(opts: SonosOptions = {}) {
  const fetchFn = opts.fetch ?? fetch;

  return defineModule({
    manifest: {
      id: "sonos",
      label: "Sonos",
      description: "Spotify playback, grouping and volume on the Sonos speakers, via Home Assistant.",
      config: [
        { key: "HA_URL", required: true, description: "Home Assistant base URL" },
        { key: "HA_TOKEN", required: true, secret: true, description: "Home Assistant long-lived access token" },
      ],
    },
    init(ctx) {
      defineSonosTools(ctx, fetchFn);
    },
  });
}

function defineSonosTools(_ctx: ModuleContext, _fetchFn: typeof fetch): void {}

export default createSonosModule();
