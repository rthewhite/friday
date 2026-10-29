import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmRequest, ModuleStorage } from "@friday/sdk";
import { createTestHost } from "@friday/sdk/test";
import { openModuleDb } from "@friday/sdk/db";
import { createBrainModule } from "../src/index.js";
import { migrations } from "../src/schema.js";
import { BrainStore } from "../src/store.js";
import { userStorage } from "../src/users.js";
import { brainStore, rows } from "./fixtures.js";

const raymond = { id: "u1", name: "Raymond" };
const sanne = { id: "u2", name: "Sanne" };
const users = [raymond, sanne];
const quiet = { log() {}, warn() {}, error() {} };

// ---- 6.1 the migration ----

test("migration 5 keeps a populated brain as it was, without a user, and gives it per-user keys", () => {
  const d = openModuleDb(":memory:", "brain");
  d.migrate(migrations.slice(0, 4));
  const at = "2026-09-01T00:00:00.000Z";
  d.db.exec(`
    INSERT INTO brain__pages (id, name, type, aliases_json, body, revision_id, created_at, updated_at) VALUES ('anouk', 'Anouk', 'person', '["Noukie"]', '## Notes\n- 2026-09-01: sister', 10, '${at}', '${at}');
    INSERT INTO brain__revisions (id, page_id, author, name, type, aliases_json, body, created_at) VALUES (10, 'anouk', 'remember', 'Anouk', 'person', '["Noukie"]', '## Notes\n- 2026-09-01: sister', '${at}');
    INSERT INTO brain__names (key, page_id, kind) VALUES ('anouk', 'anouk', 'name'), ('noukie', 'anouk', 'alias');
    INSERT INTO brain__tombstones (key, name, purged_at) VALUES ('old car', 'Old car', '${at}');
    INSERT INTO brain__runs (trigger, started_at, first_revision_id, summary) VALUES ('schedule', '${at}', 10, 'a run');
  `);
  const before = {
    pages: rows(d.db.prepare("SELECT id, name, body, is_profile, subject_id FROM brain__pages ORDER BY id").all()),
    revisions: rows(d.db.prepare("SELECT id, page_id, body FROM brain__revisions ORDER BY id").all()),
    names: rows(d.db.prepare("SELECT key, page_id, kind FROM brain__names ORDER BY key").all()),
  };
  assert.deepEqual(d.migrate(migrations), [5]);
  assert.deepEqual(rows(d.db.prepare("SELECT id, name, body, is_profile, subject_id FROM brain__pages ORDER BY id").all()), before.pages);
  assert.deepEqual(rows(d.db.prepare("SELECT id, page_id, body FROM brain__revisions ORDER BY id").all()), before.revisions);
  assert.deepEqual(rows(d.db.prepare("SELECT key, page_id, kind FROM brain__names ORDER BY key").all()), before.names);
  assert.deepEqual(rows(d.db.prepare("SELECT key, name FROM brain__tombstones").all()), [{ key: "old car", name: "Old car" }]);
  assert.deepEqual(rows(d.db.prepare("SELECT trigger, summary FROM brain__runs").all()), [{ trigger: "schedule", summary: "a run" }]);
  for (const table of ["brain__pages", "brain__names", "brain__tombstones", "brain__runs"]) {
    assert.deepEqual(rows(d.db.prepare(`SELECT DISTINCT user_id FROM ${table}`).all()), [{ user_id: null }], table);
  }
  // Names are unique per user now: two users may use the same key.
  d.db.exec("INSERT INTO brain__names (user_id, key, page_id, kind) VALUES ('u1', 'anouk', 'anouk', 'name'), ('u2', 'anouk', 'anouk', 'name')");
  assert.throws(() => d.db.exec("INSERT INTO brain__names (user_id, key, page_id, kind) VALUES ('u1', 'anouk', 'anouk', 'name')"), /UNIQUE/);
  d.close();
});

// ---- 6.2 assignment ----

test("upgrade: at init the brain from before users and its nightly state become the owner's", async () => {
  let storage: ModuleStorage | undefined;
  const probe = createBrainModule();
  // Seed keys as the old module wrote them, before the brain initialises.
  const h = await createTestHost({ ...probe, init: async (ctx) => {
    storage = ctx.storage;
    await ctx.storage.set("extract:watermark", { quietAt: "2026-09-01T00:00:00Z", ids: ["c1"] });
    await ctx.storage.set("consolidate:watermark", 42);
    return probe.init(ctx);
  } }, { users, owner: "u1" });
  assert.deepEqual(rows(h.db.prepare("SELECT DISTINCT user_id FROM brain__pages").all()), [{ user_id: "u1" }]);
  assert.deepEqual(await storage!.list(), ["user:u1:consolidate:watermark", "user:u1:extract:watermark"]);
  assert.equal(await userStorage(storage!, "u1").get("consolidate:watermark"), 42);
  assert.equal(new BrainStore(h.db, "u1").profile().id, "profile", "the existing profile is the owner's");
});

test("fresh install: the seeded brain stays unowned until the first admin is recorded, then it is theirs", async () => {
  const h = await createTestHost(createBrainModule(), { users, owner: null });
  assert.deepEqual(rows(h.db.prepare("SELECT DISTINCT user_id FROM brain__pages").all()), [{ user_id: null }]);
  // A member who uses Friday first gets a brain of their own, with a page about them.
  assert.match(h.promptContext("chat", sanne), /- Sanne \(person\)/);
  await h.recordOwner("u1");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows(h.db.prepare("SELECT user_id, count(*) AS n FROM brain__pages WHERE is_profile = 1 GROUP BY user_id ORDER BY user_id").all()), [{ user_id: "u1", n: 1 }, { user_id: "u2", n: 1 }]);
  assert.equal(new BrainStore(h.db, "u1").profile().id, "profile");
});

test("assignment changes only what has no user and is safe to repeat; an owner with a brain of their own keeps it", async () => {
  const { db } = brainStore();
  const { assignToOwner } = await import("../src/users.js");
  const storage = new (await import("@friday/sdk")).MemoryStorage();
  assert.deepEqual(await assignToOwner(db, storage, raymond, quiet), { pages: 0, runs: 0, keys: 0 }, "already the owner's");
  db.exec("UPDATE brain__pages SET user_id = NULL WHERE is_profile = 1");
  const warned: string[] = [];
  const r = await assignToOwner(db, storage, raymond, { ...quiet, warn: (m: string) => void warned.push(m) });
  assert.equal(r.pages, 1);
  // A second unowned profile while the owner has one: left alone, with a warning.
  db.exec("INSERT INTO brain__pages (id, name, type, is_profile, created_at, updated_at) VALUES ('stray', 'Profile', 'other', 1, '', '')");
  assert.equal((await assignToOwner(db, storage, raymond, { ...quiet, warn: (m: string) => void warned.push(m) })).pages, 0);
  assert.match(warned.join("\n"), /already has a brain of their own/);
});

// ---- 6.3 a store per user ----

test("same name, two brains: each user has their own Anouk, profile and subject, and never sees the other's", () => {
  const { store: mine, forUser } = brainStore();
  const hers = forUser(sanne);
  assert.equal(hers.subject().name, "Sanne", "a new brain's subject is named after its user");
  mine.appendNote("Anouk", "my sister", "person", "2026-09-29");
  hers.appendNote("Anouk", "my colleague", "person", "2026-09-29");
  const a = mine.resolve("Anouk")!;
  const b = hers.resolve("Anouk")!;
  assert.notEqual(a.id, b.id);
  assert.match(a.body, /my sister/);
  assert.match(b.body, /my colleague/);
  assert.equal(hers.get(a.id), undefined, "another user's page id means nothing here");
  assert.deepEqual(hers.revisions(a.id), []);
  assert.throws(() => hers.save(a.id, { name: "Anouk", body: "x" }, "user"), /no such page/);
  assert.notEqual(mine.profileId(), hers.profileId());
  assert.deepEqual(hers.list().map((p) => p.name).sort(), ["Anouk", "Profile", "Sanne"]);
  // A tombstone in one brain doesn't forget the name in the other.
  mine.softDelete(a.id, "user");
  mine.purge(a.id, "Anouk", "user");
  assert.deepEqual(mine.tombstones().map((t) => t.key), ["anouk"]);
  assert.deepEqual(hers.tombstones(), []);
  assert.ok(hers.resolve("Anouk"));
});

test("a new user whose name can't be a page name starts with the subject Me", () => {
  const { forUser } = brainStore();
  assert.equal(forUser({ id: "u3", name: "Profile" }).subject().name, "Me");
  assert.equal(forUser({ id: "u4", name: "a]]b" }).subject().name, "Me");
});

// ---- 7.x tools, prompt and routes per user ----

async function twoUsers(llm?: (req: LlmRequest) => string) {
  let t = Date.parse("2026-09-30T01:00:00Z");
  return createTestHost(createBrainModule({ now: () => new Date((t += 1000)) }), { users, owner: "u1", env: { FRIDAY_TIMEZONE: "Europe/Amsterdam" }, ...(llm ? { llm } : {}) });
}

test("the tools act for the call's user, else the owner", async () => {
  const h = await twoUsers();
  await h.call("brain_remember", { entity: "Boiler", fact: "serviced in March" }, { user: sanne });
  await h.call("brain_remember", { entity: "Car", fact: "needs tyres" }, { user: undefined });
  const hers = (await h.call("brain_recall", { query: "boiler" }, { user: sanne })).result as { found: boolean; pages: { name: string }[] };
  const mine = (await h.call("brain_recall", { query: "boiler" }, { user: raymond })).result as { found: boolean; pages: string[] };
  assert.deepEqual([hers.found, hers.pages.map((p) => p.name)], [true, ["Boiler"]]);
  assert.equal(mine.found, false);
  assert.ok(!mine.pages.includes("Boiler"), "her page isn't even among the owner's names");
  assert.ok(new BrainStore(h.db, "u1").resolve("Car"), "a call without a user is the owner's");
});

test("brain_recall_conversations: another user's conversations are never found", async () => {
  const h = await twoUsers();
  h.conversations.seed({ userId: "u1", channel: "chat", entries: [{ kind: "user", input: "text", text: "when is the boiler service?" }] });
  const hers = h.conversations.seed({ userId: "u2", channel: "chat", entries: [{ kind: "user", input: "text", text: "the boiler is loud" }] });
  const found = (await h.call("brain_recall_conversations", { query: "boiler" }, { user: sanne })).result as { conversations: { id: string }[] };
  assert.deepEqual(found.conversations.map((c) => c.id), [hers.id]);
});

test("a new user's prompt holds their own empty brain, not the owner's", async () => {
  const h = await twoUsers();
  await h.call("brain_remember", { entity: "Anouk", fact: "my sister lives in Utrecht", type: "person" }, { user: raymond });
  assert.match(h.promptContext("chat", raymond), /- Anouk \(person\)/);
  const hers = h.promptContext("chat", sanne);
  assert.doesNotMatch(hers, /Anouk/);
  assert.match(hers, /- Sanne \(person\)/);
  assert.match(h.promptContext("voice", null), /- Anouk/, "a prompt without a user is the owner's");
});

test("routes act for the request's user: pages/profile is theirs, and another user's page is a 404", async () => {
  const h = await twoUsers();
  const as = (user: typeof raymond) => ({ user: { ...user, role: "member" as const } });
  const page = (await h.request("POST", "pages", { name: "Boiler", body: "x" }, {}, as(sanne))).body as { id: string; revisionId: number };
  const mineProfile = (await h.request("GET", "pages/profile", undefined, {}, as(raymond))).body as { id: string };
  const herProfile = (await h.request("GET", "pages/profile", undefined, {}, as(sanne))).body as { id: string; isProfile: boolean };
  assert.equal(mineProfile.id, "profile");
  assert.notEqual(herProfile.id, "profile");
  assert.equal(herProfile.isProfile, true);
  for (const [method, path, body] of [
    ["GET", `pages/${page.id}`],
    ["PUT", `pages/${page.id}`, { name: "Boiler", body: "y", baseRevision: page.revisionId }],
    ["DELETE", `pages/${page.id}`],
    ["GET", `pages/${herProfile.id}`],
  ] as const) {
    assert.equal((await h.request(method, path, body, {}, as(raymond))).status, 404, `${method} ${path}`);
  }
  const list = (await h.request("GET", "pages", undefined, {}, as(raymond))).body as { pages: { name: string }[] };
  assert.ok(!list.pages.some((p) => p.name === "Boiler"));
  const instructions = await h.request("PUT", "pages/profile", { instructions: "Call me S.", baseRevision: (await h.request("GET", "pages/profile", undefined, {}, as(sanne))).body.revisionId }, {}, as(sanne));
  assert.equal(instructions.status, 200);
  assert.equal(new BrainStore(h.db, "u1").profile().instructions, "", "the owner's instructions are untouched");
});

// ---- 8.x the nightly pass per user ----

/** A fake model: extraction notes every user line as a fact on page `Topic`; consolidation and summary do nothing. */
function nightlyModel(failFor?: string) {
  return (req: LlmRequest) => {
    const props = (req.schema as { properties?: Record<string, unknown> })?.properties;
    if (props?.summary) return JSON.stringify({ summary: "" });
    if (!props?.notes) {
      if (failFor && req.prompt?.includes(failFor)) throw new Error("boom");
      return JSON.stringify({ actions: [], note: "nothing to tidy" });
    }
    const fact = req.prompt?.includes("boiler") ? "The kitchen boiler was serviced in March." : "The bicycle has a flat tyre.";
    return JSON.stringify({ notes: [{ entity: "Topic", fact, type: "other", reason: "stated by the user" }] });
  };
}

test("the nightly pass runs per user: each conversation's notes land in its own user's brain; the job summary has counts only", async () => {
  const h = await twoUsers(nightlyModel());
  h.conversations.seed({ userId: "u1", channel: "chat", startedAt: "2026-09-29T10:00:00Z", quietAt: "2026-09-29T10:00:00Z", lastActivityAt: "2026-09-29T10:00:00Z", entries: [{ kind: "user", input: "text", text: "the kitchen boiler was serviced in March" }] });
  h.conversations.seed({ userId: "u2", channel: "chat", startedAt: "2026-09-29T11:00:00Z", quietAt: "2026-09-29T11:00:00Z", lastActivityAt: "2026-09-29T11:00:00Z", entries: [{ kind: "user", input: "text", text: "my bicycle has a flat tyre since Friday" }] });
  const r = await h.runJob("nightly");
  assert.equal(r.outcome, "ok");
  assert.match(r.summary!, /^2 users: 2 conversations \(0 trivial\), 2 notes/);
  assert.doesNotMatch(r.summary!, /boiler|bicycle|Topic/);
  const mine = new BrainStore(h.db, "u1").resolve("Topic")?.body ?? "";
  const hers = new BrainStore(h.db, "u2").resolve("Topic")?.body ?? "";
  assert.match(mine, /boiler/);
  assert.doesNotMatch(mine, /bicycle/);
  assert.match(hers, /bicycle/);
  assert.doesNotMatch(hers, /boiler/);
  assert.deepEqual(rows(h.db.prepare("SELECT user_id, outcome, conversations FROM brain__runs ORDER BY user_id").all()), [
    { user_id: "u1", outcome: "ok", conversations: 1 },
    { user_id: "u2", outcome: "ok", conversations: 1 },
  ]);
  assert.ok(await h.storage.get("user:u2:extract:watermark"), "each user has their own watermark");
});

test("one user's failure is recorded for them, doesn't stop the others, and marks the job summary partial", async () => {
  const h = await twoUsers();
  // Sanne's nightly state is corrupt: her pass throws before it starts reading.
  const { RunStore } = await import("../src/nightly/runs.js");
  const { runNightlyForUsers, PassGuard } = await import("../src/nightly/job.js");
  const ok = { conversations: 1, skipped: 0, notes: 1, refused: 0, errors: [] };
  const steps = (user: string) => ({
    extract: async () => { if (user === "u2") throw new Error("boom"); return ok; },
    consolidate: async () => ({ ran: false, rewrites: 0, creates: 0, merges: [], dropped: [] }),
    summary: async () => ({ ran: false, generated: false }),
  });
  const { summary } = await runNightlyForUsers(users, (u) => ({ runs: new RunStore(h.db, u.id), steps: steps(u.id) }), new PassGuard(), "manual", new AbortController().signal, quiet);
  assert.match(summary, /^partial: 1 of 2 users failed; 2 users: 1 conversation/);
  assert.doesNotMatch(summary, /boom/);
  assert.deepEqual(rows(h.db.prepare("SELECT user_id, outcome, error FROM brain__runs ORDER BY user_id").all()), [
    { user_id: "u1", outcome: "ok", error: null },
    { user_id: "u2", outcome: "failed", error: "boom" },
  ]);
});

test("runs are per user: another user's run is a 404; runs/now runs the caller's pass only, 409 while it runs", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  let t = Date.parse("2026-09-30T01:00:00Z");
  const h = await createTestHost(createBrainModule({ now: () => new Date((t += 1000)) }), {
    users,
    owner: "u1",
    llm: async (req) => {
      await gate;
      return nightlyModel()(req);
    },
  });
  h.conversations.seed({ userId: "u2", channel: "chat", startedAt: "2026-09-29T11:00:00Z", quietAt: "2026-09-29T11:00:00Z", lastActivityAt: "2026-09-29T11:00:00Z", entries: [{ kind: "user", input: "text", text: "my bicycle has a flat tyre since Friday" }] });
  const as = (user: typeof raymond) => ({ user: { ...user, role: "member" as const } });
  assert.equal((await h.request("POST", "runs/now", undefined, {}, as(sanne))).status, 202);
  assert.equal((await h.request("POST", "runs/now", undefined, {}, as(sanne))).status, 409);
  assert.equal((await h.request("POST", "runs/now", undefined, {}, as(raymond))).status, 202, "another user's pass may run meanwhile");
  release!();
  const done = () => (h.db.prepare("SELECT count(*) AS n FROM brain__runs WHERE finished_at IS NOT NULL").get() as { n: number }).n === 2;
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  const runs = rows(h.db.prepare("SELECT id, user_id, trigger, conversations FROM brain__runs ORDER BY user_id").all()) as { id: number; user_id: string; trigger: string; conversations: number }[];
  assert.deepEqual(runs.map((r) => [r.user_id, r.trigger, r.conversations]), [["u1", "manual", 0], ["u2", "manual", 1]]);
  const hers = runs[1]!.id;
  assert.equal((await h.request("GET", `runs/${hers}`, undefined, {}, as(raymond))).status, 404);
  assert.equal((await h.request("POST", `runs/${hers}/pages/x/revert`, { base: 1 }, {}, as(raymond))).status, 404);
  assert.equal((await h.request("GET", `runs/${hers}`, undefined, {}, as(sanne))).status, 200);
  const listed = (await h.request("GET", "runs", undefined, {}, as(raymond))).body as { runs: { id: number }[] };
  assert.ok(!listed.runs.some((r) => r.id === hers));
});
