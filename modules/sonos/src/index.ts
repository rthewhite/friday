/**
 * Sonos speakers through Home Assistant's Sonos integration (ported from the Jarvis Sonos tool).
 *
 * Config (declared in the manifest, read lazily through ctx.config):
 *   HA_URL, HA_TOKEN   Home Assistant base URL and long-lived access token (shared with the media module)
 */
import { defineModule, Type, type ModuleContext } from "@friday/sdk";
import { createHa } from "./ha.js";
import { loadSpeakers, view } from "./speakers.js";

export interface SonosOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createSonosModule(opts: SonosOptions = {}) {
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
      defineSonosTools(ctx, opts.fetch);
    },
  });
}

function defineSonosTools(ctx: ModuleContext, fetchFn: typeof fetch | undefined): void {
  const ha = createHa(ctx.config, { fetch: fetchFn });

  ctx.defineTool({
    name: "sonos_list_speakers",
    description:
      "List the Sonos speakers: name, room (area), model, state, volume (0-100), the group a speaker plays in " +
      "(leader first) and what is playing. Speakers can be named by their room in the other sonos tools.",
    parameters: { type: Type.OBJECT, properties: {} },
    handler: async () => {
      const all = await loadSpeakers(ha);
      return { speakers: all.map((s) => view(s, all)) };
    },
  });
}

export default createSonosModule();
