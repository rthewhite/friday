/**
 * Jellyfin + Apple TV (Infuse) tools.
 *
 * Env:
 *   JELLYFIN_URL, JELLYFIN_API_KEY, JELLYFIN_USER (name; optional, defaults to first user)
 *   ATV_ID                 Apple TV identifier from `atvremote scan`
 *   ATV_COMPANION_CREDS    credentials from `atvremote --id <ATV_ID> --protocol companion pair`
 *   ATVREMOTE_BIN          path to atvremote (default: atvremote on PATH)
 *   JELLYFIN_PUBLIC_URL    URL the Apple TV should use to reach Jellyfin (default: JELLYFIN_URL)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@google/genai";
import { defineTool } from "./index.js";

const run = promisify(execFile);

const env = {
  get url() { return process.env.JELLYFIN_URL?.replace(/\/$/, ""); },
  get publicUrl() { return (process.env.JELLYFIN_PUBLIC_URL ?? process.env.JELLYFIN_URL)?.replace(/\/$/, ""); },
  get key() { return process.env.JELLYFIN_API_KEY; },
  get user() { return process.env.JELLYFIN_USER; },
  get atvId() { return process.env.ATV_ID; },
  get atvCreds() { return process.env.ATV_COMPANION_CREDS; },
  get atvBin() { return process.env.ATVREMOTE_BIN ?? "atvremote"; },
};

// ---- Jellyfin -----------------------------------------------------------

interface JfItem {
  Id: string;
  Name: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  DateCreated?: string;
  RunTimeTicks?: number;
  Overview?: string;
}

async function jf<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!env.url || !env.key) throw new Error("JELLYFIN_URL / JELLYFIN_API_KEY not configured");
  const u = new URL(env.url + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    headers: {
      Authorization: `MediaBrowser Token="${env.key}", Client="Friday", Device="Friday", DeviceId="friday", Version="0.1.0"`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`jellyfin ${path} -> ${res.status}`);
  return (await res.json()) as T;
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
  return {
    id: i.Id,
    series: i.SeriesName,
    season: i.ParentIndexNumber,
    episode: i.IndexNumber,
    title: i.Name,
    added: i.DateCreated?.slice(0, 10),
    minutes: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600_000_000) : undefined,
  };
}

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

// ---- Apple TV / Infuse --------------------------------------------------

async function atv(...cmds: string[]): Promise<string> {
  if (!env.atvId || !env.atvCreds) throw new Error("ATV_ID / ATV_COMPANION_CREDS not configured");
  const { stdout } = await run(env.atvBin, ["--id", env.atvId, "--companion-credentials", env.atvCreds, ...cmds], {
    timeout: 20_000,
  });
  return stdout.trim();
}

defineTool<{ item_id: string }>({
  name: "play_on_apple_tv",
  description: "Turn on the Apple TV and start playing a Jellyfin episode or movie in Infuse. Use an item id from list_episodes_to_watch.",
  parameters: {
    type: Type.OBJECT,
    properties: { item_id: { type: Type.STRING } },
    required: ["item_id"],
  },
  handler: async ({ item_id }) => {
    const stream = `${env.publicUrl}/Videos/${item_id}/stream?static=true&api_key=${env.key}`;
    const link = `infuse://x-callback-url/play?url=${encodeURIComponent(stream)}`;
    try {
      await atv("turn_on");
      await atv(`launch_app=${link}`);
      // Success is already implied by the model's "starting it" reply; stay quiet.
      return { started: true, scheduling: "SILENT" };
    } catch (e) {
      return { started: false, error: String(e), scheduling: "INTERRUPT" };
    }
  },
});
