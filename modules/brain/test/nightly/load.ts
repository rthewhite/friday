/**
 * Nightly fixtures (design D7): synthetic conversations with facts that must be noted and content that must
 * not be, plus consolidation cases. Tests run them against a fake model; `scripts/eval.ts` against Gemini.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeedEntry } from "@friday/sdk";
import type { TestHost } from "@friday/sdk/test";
import { preserved } from "../../src/nightly/consolidate.js";
import { validateSummary } from "../../src/nightly/summary.js";
import { BrainStore } from "../../src/store.js";
import { estimateTokens, fold } from "../../src/text.js";

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
  kind: "extraction" | "consolidation" | "summary";
  /** The body of the user's own page (the subject page). */
  me?: string;
  /** A name for the user's page instead of `Me` (the old name stays an alias). */
  meName?: string;
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
  /** No live page may have one of these as its name or alias after the run. */
  mustNotPage?: string[];
  /** Summary: the generated summary must name each of these pages with a `[[link]]`. */
  summaryLinks?: string[];
  /** Canned model answers for the fake-model tests. */
  fake?: { notes?: unknown[]; plan?: unknown; summary?: string };
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

/** Seeds a test host with the fixture's user page, pages, tombstones and conversation (quiet). Returns the conversation id. */
export async function seedFixture(h: TestHost, fx: Fixture): Promise<string | undefined> {
  if (fx.me !== undefined || fx.meName !== undefined) {
    const id = ((await h.request("GET", "pages")).body as { profile: { subjectId: string } }).profile.subjectId;
    const cur = (await h.request("GET", `pages/${id}`)).body as { name: string; body: string; revisionId: number };
    await ok(h.request("PUT", `pages/${id}`, { name: fx.meName ?? cur.name, type: "person", aliases: [], body: fx.me ?? cur.body, baseRevision: cur.revisionId }), `${fx.name}: user's page`);
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

/** The body of the live page whose name or alias is `entity` ("me" for the user's page while it has its first name or keeps it as an alias). */
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
  // Links the brain added don't change what a page says: "[[Raymond]]'s brother" contains "Raymond's brother".
  const says = (body: string, text: string) => [body, body.replace(/\[\[([^[\]\n]+)\]\]/g, "$1")].some((b) => b.toLowerCase().includes(text.toLowerCase()));
  for (const m of fx.mustNote ?? []) out.push({ expectation: `note on ${m.entity} contains "${m.contains}"`, ok: says(bodyOf(h, m.entity) ?? "", m.contains) });
  for (const p of fx.mustNotNote ?? []) {
    const needle = p.toLowerCase();
    out.push({ expectation: `nothing new mentions "${p}"`, ok: !after.includes(needle) || before.includes(needle) });
  }
  // Kept means stated verbatim or with most of its words, as consolidation's own loss check counts it.
  const folded = fold(after);
  for (const k of fx.mustKeep ?? []) out.push({ expectation: `still states "${k}"`, ok: after.includes(k.toLowerCase()) || preserved(k, folded) });
  for (const n of fx.mustNotPage ?? []) out.push({ expectation: `no page named "${n}"`, ok: bodyOf(h, n) === undefined });
  if (fx.kind === "summary") {
    // The summary as written, checked by the same rules the nightly pass uses before writing it.
    const summary = (h.db.prepare("SELECT body FROM brain__pages WHERE id = 'profile'").get() as { body: string }).body;
    const budget = Number(fx.env?.BRAIN_PROFILE_TOKEN_BUDGET ?? 800);
    const reasons = validateSummary(new BrainStore(h.db), summary, budget);
    out.push({ expectation: "a summary was written", ok: summary.trim() !== "" });
    out.push({ expectation: `the summary is within ${budget} tokens (${estimateTokens(summary)})`, ok: estimateTokens(summary) <= budget });
    out.push({ expectation: `every line of the summary is backed and every link resolves${reasons.length ? `: ${reasons.join("; ")}` : ""}`, ok: !reasons.length });
    for (const n of fx.summaryLinks ?? []) out.push({ expectation: `the summary links [[${n}]]`, ok: summary.toLowerCase().includes(`[[${n.toLowerCase()}]]`) });
  }
  return out;
}
