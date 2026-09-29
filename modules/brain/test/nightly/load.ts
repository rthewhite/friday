/**
 * Nightly fixtures (design D7): synthetic conversations with facts that must be noted and content that must
 * not be, plus consolidation cases. Tests run them against a fake model; `scripts/eval.ts` against Gemini.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeedEntry } from "@friday/sdk";
import type { TestHost } from "@friday/sdk/test";

export interface FixturePage {
  name: string;
  type?: "person" | "place" | "project" | "other";
  aliases?: string[];
  body?: string;
}

export interface Fixture {
  /** File name without `.json`. */
  name: string;
  description: string;
  kind: "extraction" | "consolidation";
  profile?: string;
  pages?: FixturePage[];
  /** Names purged before the conversation (they end up tombstoned). */
  tombstones?: string[];
  /** Module config, e.g. BRAIN_PROFILE_TOKEN_BUDGET. */
  env?: Record<string, string>;
  conversation?: {
    id?: string;
    channel?: "voice" | "chat";
    device?: string | null;
    lastActivityAt?: string;
    /** Entries up to this seq were processed on an earlier run. */
    seen?: number;
    entries: SeedEntry[];
  };
  /** Each must appear, case-insensitively, on the named page after the run. */
  mustNote?: { entity: string; contains: string }[];
  /** None of these may appear (case-insensitively) on any page after the run, unless it was there before. */
  mustNotNote?: string[];
  /** Consolidation: each line's text must still be stated somewhere after the run. */
  mustKeep?: string[];
  /** Consolidation: lines that may be dropped (superseded). */
  mayDrop?: string[];
  /** Canned model answers for the fake-model tests. */
  fake?: { notes?: unknown[]; plan?: unknown };
}

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "nightly");

export function loadFixtures(dir = FIXTURE_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<Fixture, "name">), name: f.replace(/\.json$/, "") }));
}

async function ok(r: Promise<{ status: number; body: unknown }>, what: string) {
  const res = await r;
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; revisionId: number };
}

/** Seeds a test host with the fixture's profile, pages, tombstones and conversation (quiet). Returns the conversation id. */
export async function seedFixture(h: TestHost, fx: Fixture): Promise<string | undefined> {
  if (fx.profile !== undefined) {
    const cur = (await h.request("GET", "pages/profile")).body as { revisionId: number };
    await ok(h.request("PUT", "pages/profile", { name: "Profile", type: "other", aliases: [], body: fx.profile, baseRevision: cur.revisionId }), `${fx.name}: profile`);
  }
  for (const name of fx.tombstones ?? []) {
    const p = await ok(h.request("POST", "pages", { name }), `${fx.name}: tombstone ${name}`);
    await h.request("DELETE", `pages/${p.id}`);
    await ok(h.request("POST", `pages/${p.id}/purge`, { confirm: name }), `${fx.name}: purge ${name}`);
  }
  for (const p of fx.pages ?? []) await ok(h.request("POST", "pages", { type: "other", ...p }), `${fx.name}: page ${p.name}`);
  const c = fx.conversation;
  if (!c) return undefined;
  const at = c.lastActivityAt ?? "2026-09-29T18:00:00.000Z";
  const seeded = h.conversations.seed({
    ...(c.id ? { id: c.id } : {}),
    channel: c.channel ?? "chat",
    device: c.device ?? null,
    startedAt: new Date(Date.parse(at) - 10 * 60_000).toISOString(),
    lastActivityAt: at,
    quietAt: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
    entries: c.entries.map((e) => ({ at, ...e })),
  });
  if (c.seen) await h.storage.set(`extract:seen:${seeded.id}`, { seq: c.seen });
  return seeded.id;
}

/** All page bodies, names and aliases as one lower-cased text. */
export function brainText(h: TestHost): string {
  return (h.db.prepare("SELECT name, aliases_json, body FROM brain__pages WHERE deleted_at IS NULL").all() as { name: string; aliases_json: string; body: string }[])
    .map((p) => `${p.name}\n${p.aliases_json}\n${p.body}`)
    .join("\n")
    .toLowerCase();
}

/** The body of the live page whose name or alias is `entity` ("profile" for the profile). */
export function bodyOf(h: TestHost, entity: string): string | undefined {
  const row = h.db.prepare("SELECT p.body FROM brain__names n JOIN brain__pages p ON p.id = n.page_id WHERE n.key = ?").get(entity.trim().toLowerCase()) as { body: string } | undefined;
  return row?.body;
}

export interface Check {
  expectation: string;
  ok: boolean;
}

/** The fixture's expectations against the brain after a run. `before` is `brainText` before the run. */
export function checkFixture(h: TestHost, fx: Fixture, before: string): Check[] {
  const after = brainText(h);
  const out: Check[] = [];
  for (const m of fx.mustNote ?? []) out.push({ expectation: `note on ${m.entity} contains "${m.contains}"`, ok: (bodyOf(h, m.entity) ?? "").toLowerCase().includes(m.contains.toLowerCase()) });
  for (const p of fx.mustNotNote ?? []) {
    const needle = p.toLowerCase();
    out.push({ expectation: `nothing new mentions "${p}"`, ok: !after.includes(needle) || before.includes(needle) });
  }
  const folded = after.replace(/\s+/g, " ");
  for (const k of fx.mustKeep ?? []) out.push({ expectation: `still states "${k}"`, ok: folded.includes(k.toLowerCase()) });
  return out;
}
