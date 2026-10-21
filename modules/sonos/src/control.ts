/** Grouping and playback on resolved speakers, as Home Assistant service calls. */
import type { ToolResult } from "@friday/sdk";
import type { HaClient } from "./ha.js";
import { normalize, type Speaker } from "./speakers.js";

/**
 * Home-theatre models must lead a group (Jarvis's rule). HA has no speaker-type attribute, so this
 * goes by model name; the prefix match also covers variants such as "Beam (Gen 2)".
 */
const HOME_THEATRE = ["arcultra", "arc", "beam", "ray", "playbar", "playbase", "amp"];

export const isHomeTheatre = (s: Speaker): boolean => s.model !== undefined && HOME_THEATRE.some((m) => normalize(s.model!).startsWith(m));

/** The leader for several speakers: the first home theatre among them, else the first one. */
export function pickLeader(speakers: Speaker[]): Speaker {
  return speakers.find(isHomeTheatre) ?? speakers[0];
}

const unjoin = (ha: HaClient, entities: string[]) => ha.call("media_player", "unjoin", { entity_id: entities });

/** Make `speakers` exactly one Sonos group and return its leader. */
async function groupExactly(ha: HaClient, speakers: Speaker[]): Promise<Speaker> {
  if (speakers.length === 1) {
    const [only] = speakers;
    if (only.members.length > 1) await unjoin(ha, [only.entity]);
    return only;
  }
  const leader = pickLeader(speakers);
  const used = new Set(speakers.map((s) => s.entity));
  let group = leader.members;
  if (group.length > 1 && group[0] !== leader.entity) {
    // The leader is a member of someone else's group: take it out so it can lead its own.
    await unjoin(ha, [leader.entity]);
    group = [leader.entity];
  } else {
    const extra = group.filter((e) => !used.has(e));
    if (extra.length) await unjoin(ha, extra);
  }
  const joiners = speakers.filter((s) => s !== leader && !group.includes(s.entity)).map((s) => s.entity);
  if (joiners.length) await ha.call("media_player", "join", { entity_id: leader.entity, group_members: joiners });
  return leader;
}

/**
 * HA's Sonos integration gives a share link up to 30 s to resolve and queue (a long playlist), so
 * `play_media` waits longer than other requests: an earlier timeout would report a failure for
 * music that then starts, and send the next add while HA is still busy with this one.
 */
export const PLAY_MEDIA_TIMEOUT_MS = 45_000;

/** Group the speakers, replace the leader's queue with the first URI and add the rest in order. */
export async function play(ha: HaClient, speakers: Speaker[], uris: string[]): Promise<ToolResult> {
  const leader = await groupExactly(ha, speakers);
  const media = (uri: string, enqueue: "replace" | "add") =>
    ha.call("media_player", "play_media", { entity_id: leader.entity, media_content_id: uri, media_content_type: "music", enqueue }, PLAY_MEDIA_TIMEOUT_MS);

  await media(uris[0], "replace");
  let queued = 1;
  const failed: string[] = [];
  for (const uri of uris.slice(1)) {
    try {
      await media(uri, "add");
      queued++;
    } catch (err) {
      failed.push(`${uri} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const result: ToolResult = { playing: speakers.map((s) => s.name), leader: leader.name, queued };
  if (!failed.length) return { ...result, scheduling: "SILENT" };
  return { ...result, warning: `Playing, but these could not be added to the queue: ${failed.join("; ")}`, scheduling: "WHEN_IDLE" };
}

export type Transport = "pause" | "resume" | "stop";

const TRANSPORT: Record<Transport, { service: string; key: string }> = {
  pause: { service: "media_pause", key: "paused" },
  resume: { service: "media_play", key: "resumed" },
  stop: { service: "media_stop", key: "stopped" },
};

/**
 * Pause, resume or stop: once per distinct group, sent to its leader, all leaders in one service
 * call. A Sonos group plays as one, so the result names every speaker in the groups affected.
 */
export async function transport(ha: HaClient, all: Speaker[], speakers: Speaker[], action: Transport): Promise<ToolResult> {
  const leaders = [...new Set(speakers.map((s) => s.members[0]))];
  await ha.call("media_player", TRANSPORT[action].service, { entity_id: leaders });
  const affected: string[] = [];
  for (const leader of leaders) {
    const members = all.find((s) => s.entity === leader)?.members ?? [leader];
    for (const e of members) affected.push(all.find((s) => s.entity === e)?.name ?? e);
  }
  return { [TRANSPORT[action].key]: [...new Set(affected)], scheduling: "SILENT" };
}

/** Check a volume before anything changes: 0-100, rounded to a whole number. */
export function checkVolume(volume: unknown): number {
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
    throw new Error("Volume must be a number from 0 to 100");
  }
  return Math.round(volume);
}

/**
 * Set the volume on each speaker individually, also when they are grouped (one service call
 * listing them, so they change together rather than one request after another).
 */
export async function setVolume(ha: HaClient, speakers: Speaker[], volume: number): Promise<ToolResult> {
  await ha.call("media_player", "volume_set", { entity_id: speakers.map((s) => s.entity), volume_level: volume / 100 });
  return { volume, speakers: speakers.map((s) => s.name), scheduling: "SILENT" };
}

/**
 * Take speakers out of their groups: the named ones that are grouped, or, with none named, every
 * member that isn't a leader, so each speaker ends up on its own.
 */
export async function ungroup(ha: HaClient, all: Speaker[], named: Speaker[] | undefined): Promise<ToolResult> {
  const leaving = named
    ? named.filter((s) => s.members.length > 1)
    : all.filter((s) => s.members.length > 1 && s.members[0] !== s.entity);
  if (leaving.length) await unjoin(ha, leaving.map((s) => s.entity));
  return { ungrouped: leaving.map((s) => s.name), scheduling: "SILENT" };
}
