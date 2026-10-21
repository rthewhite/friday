/**
 * The speakers: the media_player entities of Home Assistant's `sonos` integration, read with one
 * template request per call (the REST state API has no areas or device models).
 */
import type { HaClient } from "./ha.js";

/** Renders every Sonos media player as one JSON array. Group entities and other integrations are left out. */
export const SPEAKERS_TEMPLATE =
  "{% set ns = namespace(items=[]) %}" +
  "{% for e in integration_entities('sonos') if e.startswith('media_player.') %}" +
  "{% set d = device_id(e) %}" +
  "{% set ns.items = ns.items + [{" +
  "'entity': e, 'name': state_attr(e, 'friendly_name'), 'area': area_name(e), " +
  "'model': device_attr(d, 'model') if d else none, 'state': states(e), " +
  "'volume': state_attr(e, 'volume_level'), 'group': state_attr(e, 'group_members'), " +
  "'title': state_attr(e, 'media_title'), 'artist': state_attr(e, 'media_artist')}] %}" +
  "{% endfor %}" +
  "{{ ns.items | tojson }}";

export interface Speaker {
  entity: string;
  name: string;
  area?: string;
  model?: string;
  state: string;
  /** 0-100. */
  volume?: number;
  /** Entity ids of the speaker's Sonos group, leader first; just the speaker itself when it plays alone. */
  members: string[];
  title?: string;
  artist?: string;
}

/** What `sonos_list_speakers` returns for one speaker. */
export interface SpeakerView {
  name: string;
  area?: string;
  model?: string;
  entity: string;
  state: string;
  volume?: number;
  group?: string[];
  playing?: { title: string; artist?: string };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Parse the template's output. Anything that isn't the expected array fails as a lookup error. */
export function parseSpeakers(raw: string): Speaker[] {
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new Error("Sonos speaker lookup failed: Home Assistant returned something other than JSON");
  }
  if (!Array.isArray(rows)) throw new Error("Sonos speaker lookup failed: Home Assistant did not return a list");
  const speakers: Speaker[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const entity = text(r.entity);
    if (!entity) continue;
    const group = Array.isArray(r.group) ? r.group.filter((m): m is string => typeof m === "string") : [];
    speakers.push({
      entity,
      name: text(r.name) ?? entity,
      area: text(r.area),
      model: text(r.model),
      state: text(r.state) ?? "unknown",
      volume: typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.round(r.volume * 100) : undefined,
      members: group.length ? group : [entity],
      title: text(r.title),
      artist: text(r.artist),
    });
  }
  return speakers;
}

export async function loadSpeakers(ha: HaClient): Promise<Speaker[]> {
  let raw: string;
  try {
    raw = await ha.template(SPEAKERS_TEMPLATE);
  } catch (err) {
    throw new Error(`Sonos speaker lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSpeakers(raw);
}

/** A speaker's group by name, leader first; undefined when it plays alone. */
export function groupNames(speaker: Speaker, all: Speaker[]): string[] | undefined {
  if (speaker.members.length <= 1) return undefined;
  return speaker.members.map((e) => all.find((s) => s.entity === e)?.name ?? e);
}

export function view(speaker: Speaker, all: Speaker[]): SpeakerView {
  const v: SpeakerView = {
    name: speaker.name,
    ...(speaker.area && { area: speaker.area }),
    ...(speaker.model && { model: speaker.model }),
    entity: speaker.entity,
    state: speaker.state,
    ...(speaker.volume !== undefined && { volume: speaker.volume }),
  };
  const group = groupNames(speaker, all);
  if (group) v.group = group;
  if ((speaker.state === "playing" || speaker.state === "paused") && speaker.title) {
    v.playing = speaker.artist ? { title: speaker.title, artist: speaker.artist } : { title: speaker.title };
  }
  return v;
}

/** Lowercase letters and digits only, so "[Hobby Room] Sonos" and "hobby room sonos" match. */
export const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function matches(ref: string, all: Speaker[]): Speaker[] {
  const n = normalize(ref);
  if (!n) return [];
  const byEntity = all.filter((s) => normalize(s.entity) === n || normalize(s.entity.replace(/^media_player\./, "")) === n);
  if (byEntity.length) return byEntity;
  const byName = all.filter((s) => normalize(s.name) === n);
  if (byName.length) return byName;
  return all.filter((s) => s.area !== undefined && normalize(s.area) === n);
}

function available(all: Speaker[]): string {
  if (!all.length) return "none";
  return all.map((s) => (s.area ? `${s.name} (${s.area})` : s.name)).join(", ");
}

/**
 * Resolve speaker references (entity id, then name, then area; an area gives all its speakers) to
 * speakers, once each in first-referenced order. Throws before anything changes on an unknown
 * reference or an unavailable speaker.
 */
export function resolve(refs: unknown, all: Speaker[]): Speaker[] {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error("Name at least one Sonos speaker or room");
  const out: Speaker[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string") throw new Error("Speakers must be names or rooms");
    const found = matches(ref, all);
    if (!found.length) throw new Error(`No Sonos speaker or room matches "${ref}". Available: ${available(all)}`);
    for (const s of found) if (!out.includes(s)) out.push(s);
  }
  const down = out.find((s) => s.state === "unavailable");
  if (down) throw new Error(`Sonos speaker ${down.name} is unavailable`);
  return out;
}
