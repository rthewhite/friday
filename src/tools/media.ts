/**
 * Jellyfin + Apple TV (Infuse) tools.
 *
 * Env:
 *   JELLYFIN_URL, JELLYFIN_API_KEY, JELLYFIN_USER (name; optional, defaults to first user)
 *   HA_URL, HA_TOKEN       Home Assistant base URL and long-lived access token
 *   HA_APPLE_TV_ENTITY     media_player entity of the Apple TV (e.g. media_player.living_room)
 *   JELLYFIN_PUBLIC_URL    URL the Apple TV should use to reach Jellyfin (default: JELLYFIN_URL)
 */
import { Type } from "@google/genai";
import { haCall, haState } from "../ha.js";
import { defineTool } from "./index.js";

const env = {
  get url() { return process.env.JELLYFIN_URL?.replace(/\/$/, ""); },
  get publicUrl() { return (process.env.JELLYFIN_PUBLIC_URL ?? process.env.JELLYFIN_URL)?.replace(/\/$/, ""); },
  get key() { return process.env.JELLYFIN_API_KEY; },
  get user() { return process.env.JELLYFIN_USER; },
  get atvEntity() { return process.env.HA_APPLE_TV_ENTITY; },
};

// ---- Jellyfin -----------------------------------------------------------

interface JfItem {
  Id: string;
  Name: string;
  Type?: string;
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  DateCreated?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  Overview?: string;
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number; PlayedPercentage?: number; UnplayedItemCount?: number };
}

const TICKS_PER_MIN = 600_000_000;

async function jf<T>(path: string, params: Record<string, string | number> = {}, method: "GET" | "POST" = "GET"): Promise<T> {
  if (!env.url || !env.key) throw new Error("JELLYFIN_URL / JELLYFIN_API_KEY not configured");
  const u = new URL(env.url + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    method,
    headers: {
      Authorization: `MediaBrowser Token="${env.key}", Client="Friday", Device="Friday", DeviceId="friday", Version="0.1.0"`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`jellyfin ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Mark an item played for the configured user (Jellyfin 10.9+ endpoint). */
async function markPlayed(itemId: string): Promise<void> {
  await jf(`/UserPlayedItems/${itemId}`, { userId: await userId() }, "POST");
}

let userIdCache: string | undefined;
async function userId(): Promise<string> {
  if (userIdCache) return userIdCache;
  const users = await jf<Array<{ Id: string; Name: string }>>("/Users");
  const u = env.user ? users.find((x) => x.Name.toLowerCase() === env.user!.toLowerCase()) : users[0];
  if (!u) throw new Error(`jellyfin user ${env.user ?? "(any)"} not found`);
  return (userIdCache = u.Id);
}

function compact(i: JfItem) {
  const pos = i.UserData?.PlaybackPositionTicks ?? 0;
  return {
    id: i.Id,
    type: i.Type,
    series: i.SeriesName,
    season: i.ParentIndexNumber,
    episode: i.IndexNumber,
    title: i.Name,
    year: i.ProductionYear,
    added: i.DateCreated?.slice(0, 10),
    minutes: i.RunTimeTicks ? Math.round(i.RunTimeTicks / TICKS_PER_MIN) : undefined,
    watched: i.UserData?.Played || undefined,
    resume_at_minutes: pos ? Math.round(pos / TICKS_PER_MIN) : undefined,
    unplayed_episodes: i.UserData?.UnplayedItemCount,
  };
}

async function searchItems(uid: string, query: string, types: string, limit: number): Promise<JfItem[]> {
  const r = await jf<{ Items: JfItem[] }>("/Items", {
    userId: uid, searchTerm: query, includeItemTypes: types, recursive: "true", limit,
    fields: "ProductionYear,DateCreated", enableTotalRecordCount: "false",
  });
  return r.Items;
}

/** Episode to play for a series: a partially watched one, else the next unwatched, else episode 1. */
async function nextEpisode(uid: string, seriesId: string): Promise<{ episode: JfItem; reason: string } | null> {
  const nextUp = await jf<{ Items: JfItem[] }>("/Shows/NextUp", {
    userId: uid, seriesId, limit: 1, enableResumable: "true", fields: "DateCreated", enableTotalRecordCount: "false",
  });
  const n = nextUp.Items[0];
  if (n) return { episode: n, reason: n.UserData?.PlaybackPositionTicks ? "resume partially watched" : "next unwatched" };
  const eps = await jf<{ Items: JfItem[] }>(`/Shows/${seriesId}/Episodes`, { userId: uid, fields: "DateCreated" });
  const first = eps.Items.find((e) => !e.UserData?.Played) ?? eps.Items[0];
  return first ? { episode: first, reason: eps.Items.every((e) => e.UserData?.Played) ? "all watched, starting over" : "first episode" } : null;
}

defineTool<{ query: string; type?: "series" | "movie" | "any"; limit?: number }>({
  name: "search_library",
  description:
    "Search the Jellyfin library for TV series and movies by name. Returns ids, year, and watch state (movies: watched / resume position; series: unplayed episode count). Use get_next_episode for a series, or play_on_apple_tv directly for a movie.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING },
      type: { type: Type.STRING, enum: ["series", "movie", "any"] },
      limit: { type: Type.INTEGER, description: "default 6" },
    },
    required: ["query"],
  },
  handler: async ({ query, type = "any", limit = 6 }) => {
    const types = type === "series" ? "Series" : type === "movie" ? "Movie" : "Series,Movie";
    const items = await searchItems(await userId(), query, types, limit);
    return { results: items.map(compact) };
  },
});

defineTool<{ series: string }>({
  name: "get_next_episode",
  description:
    "For a TV series (by name or id), work out which episode to play to continue watching: a partially watched episode is resumed, otherwise the next unwatched one, otherwise episode 1. Returns the episode id for play_on_apple_tv.",
  parameters: { type: Type.OBJECT, properties: { series: { type: Type.STRING, description: "series name or Jellyfin id" } }, required: ["series"] },
  handler: async ({ series }) => {
    const uid = await userId();
    let seriesId = series;
    let seriesName = series;
    if (!/^[0-9a-f]{32}$/i.test(series)) {
      const hits = await searchItems(uid, series, "Series", 3);
      if (!hits.length) return { error: `no series matching "${series}"` };
      seriesId = hits[0].Id;
      seriesName = hits[0].Name;
      if (hits.length > 1) {
        const alternatives = hits.slice(1).map((h) => `${h.Name} (${h.ProductionYear ?? "?"})`);
        return { series: seriesName, ...(await nextEpisode(uid, seriesId).then((r) => r ? { reason: r.reason, episode: compact(r.episode) } : { error: "series has no episodes" })), other_matches: alternatives };
      }
    }
    const r = await nextEpisode(uid, seriesId);
    if (!r) return { error: `${seriesName} has no episodes` };
    return { series: seriesName, reason: r.reason, episode: compact(r.episode) };
  },
});

defineTool<{ kind?: "next_up" | "recently_added"; limit?: number }>({
  name: "list_episodes_to_watch",
  description:
    "List TV episodes ready to watch on Jellyfin. 'next_up' (default) gives the next unwatched episode of shows in progress; 'recently_added' gives newly added episodes. Returns item ids usable with play_on_apple_tv.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      kind: { type: Type.STRING, enum: ["next_up", "recently_added"] },
      limit: { type: Type.INTEGER, description: "max results, default 8" },
    },
  },
  handler: async ({ kind = "next_up", limit = 8 }) => {
    const uid = await userId();
    const fields = "DateCreated,Overview";
    const items =
      kind === "recently_added"
        ? await jf<JfItem[]>(`/Users/${uid}/Items/Latest`, { includeItemTypes: "Episode", limit, fields, groupItems: "false" })
        : (await jf<{ Items: JfItem[] }>("/Shows/NextUp", { userId: uid, limit, fields, enableTotalRecordCount: "false" })).Items;
    return { kind, episodes: items.map(compact) };
  },
});

// ---- Apple TV / Infuse via Home Assistant --------------------------------

defineTool<{ item_id: string }>({
  name: "play_on_apple_tv",
  description:
    "Turn on the Apple TV (via Home Assistant) and start playing a Jellyfin episode or movie in Infuse. Use an item id from list_episodes_to_watch, search_library or get_next_episode. The item is marked as watched in Jellyfin automatically.",
  parameters: {
    type: Type.OBJECT,
    properties: { item_id: { type: Type.STRING } },
    required: ["item_id"],
  },
  handler: async ({ item_id }) => {
    const stream = `${env.publicUrl}/Videos/${item_id}/stream?static=true&api_key=${env.key}`;
    const link = `infuse://x-callback-url/play?url=${encodeURIComponent(stream)}`;
    try {
      const entity_id = env.atvEntity;
      if (!entity_id) throw new Error("HA_APPLE_TV_ENTITY not configured");
      // HA answers 200 to service calls on unknown/unavailable entities, so check first.
      const st = await haState(entity_id).catch(() => null);
      if (!st) throw new Error(`Home Assistant has no entity ${entity_id}`);
      if (st.state === "unavailable" || st.state === "unknown") throw new Error(`${entity_id} is ${st.state} in Home Assistant`);
      await haCall("media_player", "turn_on", { entity_id });
      // HA's apple_tv integration routes media_content_type "url" to pyatv launch_app (deep link).
      await haCall("media_player", "play_media", { entity_id, media_content_type: "url", media_content_id: link });
      // Infuse won't report progress for a URL stream, so record the watch ourselves.
      try {
        await markPlayed(item_id);
      } catch (e) {
        return { started: true, marked_watched: false, warning: `could not mark as watched: ${e}`, scheduling: "WHEN_IDLE" };
      }
      // Success is already implied by the model's "starting it" reply; stay quiet.
      return { started: true, marked_watched: true, scheduling: "SILENT" };
    } catch (e) {
      return { started: false, error: String(e), scheduling: "INTERRUPT" };
    }
  },
});
