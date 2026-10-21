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

/** Group the speakers, replace the leader's queue with the first URI and add the rest in order. */
export async function play(ha: HaClient, speakers: Speaker[], uris: string[]): Promise<ToolResult> {
  const leader = await groupExactly(ha, speakers);
  const media = (uri: string, enqueue: "replace" | "add") =>
    ha.call("media_player", "play_media", { entity_id: leader.entity, media_content_id: uri, media_content_type: "music", enqueue });

  await media(uris[0], "replace");
  let queued = 1;
  const failed: string[] = [];
  for (const uri of uris.slice(1)) {
    try {
      await media(uri, "add");
      queued++;
    } catch {
      failed.push(uri);
    }
  }
  const result: ToolResult = { playing: speakers.map((s) => s.name), leader: leader.name, queued };
  if (!failed.length) return { ...result, scheduling: "SILENT" };
  return { ...result, warning: `Playing, but these could not be added to the queue: ${failed.join(", ")}`, scheduling: "WHEN_IDLE" };
}
