/**
 * Sonos speakers through Home Assistant's Sonos integration (ported from the Jarvis Sonos tool).
 *
 * Config (declared in the manifest, read lazily through ctx.config):
 *   HA_URL, HA_TOKEN   Home Assistant base URL and long-lived access token (shared with the media module)
 */
import { defineModule, Type, type ModuleContext, type Schema } from "@friday/sdk";
import { createHa } from "./ha.js";
import { loadSpeakers, resolve, view } from "./speakers.js";
import { checkUris, MAX_URIS } from "./uris.js";
import { checkVolume, play, setVolume, transport, ungroup, type Transport } from "./control.js";

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

const SPEAKERS: Schema = {
  type: Type.ARRAY,
  items: { type: Type.STRING },
  description: "Rooms (Home Assistant areas, e.g. the room you are in) or speaker names. A room means every Sonos speaker in it.",
};

function defineSonosTools(ctx: ModuleContext, fetchFn: typeof fetch | undefined): void {
  const ha = createHa(ctx.config, { fetch: fetchFn });

  ctx.defineTool({
    name: "sonos_list_speakers",
    description:
      "List the Sonos speakers: name, room (area), model, state, volume (0-100), the group a speaker plays in " +
      "(leader first) and what is playing. The other sonos tools take rooms or speaker names.",
    parameters: { type: Type.OBJECT, properties: {} },
    handler: async () => {
      const all = await loadSpeakers(ha);
      return { speakers: all.map((s) => view(s, all)) };
    },
  });

  ctx.defineTool<{ speakers: string[]; uris: string[] }>({
    name: "sonos_play",
    description:
      "Play Spotify music on one or more Sonos speakers. The speakers named become one group for synchronized " +
      "multi-room playback (speakers not named leave it). Takes Spotify track, album, playlist, episode or show URIs " +
      "(spotify:album:ID) or open.spotify.com links; the first replaces the queue and the rest are added after it. " +
      "Artist URIs are not accepted: play the artist's tracks, an album or a playlist instead.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        speakers: SPEAKERS,
        uris: { type: Type.ARRAY, items: { type: Type.STRING }, description: `1 to ${MAX_URIS} Spotify URIs or open.spotify.com links, in play order` },
      },
      required: ["speakers", "uris"],
    },
    handler: async ({ speakers, uris }) => {
      const checked = checkUris(uris);
      return play(ha, resolve(speakers, await loadSpeakers(ha)), checked);
    },
  });

  const transportTool = (action: Transport, description: string) =>
    ctx.defineTool<{ speakers: string[] }>({
      name: `sonos_${action}`,
      description,
      parameters: { type: Type.OBJECT, properties: { speakers: SPEAKERS }, required: ["speakers"] },
      handler: async ({ speakers }) => {
        const all = await loadSpeakers(ha);
        return transport(ha, all, resolve(speakers, all), action);
      },
    });
  const wholeGroup = "A Sonos group plays as one, so this acts on the whole group of each speaker named.";
  transportTool("pause", `Pause the music on Sonos speakers. ${wholeGroup}`);
  transportTool("resume", `Resume paused music on Sonos speakers. ${wholeGroup}`);
  transportTool("stop", `Stop the music on Sonos speakers. ${wholeGroup}`);

  ctx.defineTool<{ speakers: string[]; volume: number }>({
    name: "sonos_set_volume",
    description: "Set the volume (0-100) of Sonos speakers. It is set on each speaker named individually, also when they are grouped.",
    parameters: {
      type: Type.OBJECT,
      properties: { speakers: SPEAKERS, volume: { type: Type.NUMBER, description: "Volume from 0 to 100" } },
      required: ["speakers", "volume"],
    },
    handler: async ({ speakers, volume }) => {
      const level = checkVolume(volume);
      return setVolume(ha, resolve(speakers, await loadSpeakers(ha)), level);
    },
  });

  ctx.defineTool<{ speakers?: string[] }>({
    name: "sonos_ungroup",
    description: "Take Sonos speakers out of their groups so each plays on its own. Without speakers, every group is split up.",
    parameters: {
      type: Type.OBJECT,
      properties: { speakers: { ...SPEAKERS, description: `${SPEAKERS.description} Leave out to ungroup every speaker.` } },
    },
    handler: async ({ speakers }) => {
      const all = await loadSpeakers(ha);
      return ungroup(ha, all, speakers?.length ? resolve(speakers, all) : undefined);
    },
  });
}

export default createSonosModule();
