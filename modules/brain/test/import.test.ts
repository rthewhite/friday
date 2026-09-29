import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { runImport, type JarvisExport } from "../src/import.js";
import { BrainError } from "../src/store.js";
import { brainStore } from "./fixtures.js";

const at = (d: string) => `2026-${d}T12:00:00.000Z`;

/** A Jarvis export: a profile, 12 live pages, 2 deleted pages (one sharing a live name) and 3 tombstones. */
function sample(): JarvisExport {
  const pages = [
    { name: "Car", type: "other", aliases: [], body: "Blue Volvo, APK in March.", createdAt: at("01-01"), updatedAt: at("02-01") },
    { name: "Anouk", type: "person", aliases: ["Noukie"], body: "My sister. See [[Family]].", createdAt: at("01-02"), updatedAt: at("09-01") },
    { name: "Family", type: "other", aliases: [], body: "- Sister: [[Anouk]]\n- Brother: [[Bram]]", createdAt: at("01-03"), updatedAt: at("05-01") },
  ];
  for (let i = 1; i <= 9; i++) pages.push({ name: `Page ${i}`, type: "project", aliases: [], body: `Body ${i}`, createdAt: at("01-04"), updatedAt: at(`03-${String(10 + i)}`) });
  return {
    profile: { body: "Lives in Amsterdam with Sam.\nPrefers tea.", aliases: [] },
    pages,
    deleted: [
      { name: "Old car", type: "other", aliases: [], body: "Red Fiat", createdAt: at("01-01"), updatedAt: at("01-05"), deletedAt: at("01-06") },
      { name: "Car", type: "other", aliases: [], body: "An older Car page", createdAt: at("01-01"), updatedAt: at("01-02"), deletedAt: at("01-03") },
    ],
    tombstones: [{ name: "old job", purgedAt: at("04-01") }, { name: "acme", purgedAt: at("04-01") }, { name: "ex", purgedAt: at("04-02") }],
  };
}

async function host() {
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-30T10:00:00Z") }));
  const post = async (b: unknown) => {
    const r = await h.request("POST", "import", b);
    return { status: r.status, body: r.body as any };
  };
  const rows = (sql: string, ...args: string[]) => h.db.prepare(sql).all(...args).map((r) => ({ ...r })) as any[];
  return { h, post, rows };
}

test("a dry run reports the counts and changes nothing", async () => {
  const { h, post, rows } = await host();
  const r = await post({ ...sample(), dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, false);
  assert.deepEqual(r.body.report.counts, { profile: 1, pages: 12, deleted: 2, tombstones: 3 });
  assert.deepEqual(r.body.report.problems, []);
  assert.deepEqual([r.body.report.profileTokens, r.body.report.budgetTokens], [11, 800]);
  assert.equal(rows("SELECT * FROM brain__pages").length, 1);
  assert.equal(rows("SELECT * FROM brain__tombstones").length, 0);
  // Without the flag, it is a dry run too.
  assert.equal((await post(sample())).body.applied, false);
  assert.equal(rows("SELECT * FROM brain__pages").length, 1);
  void h;
});

test("an import creates the pages, deleted pages and tombstones, with one noted user revision each and Jarvis's times", async () => {
  const { h, post, rows } = await host();
  const r = await post({ ...sample(), dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied, true);
  const list = (await h.request("GET", "pages")).body as any;
  assert.equal(list.pages.length, 13);
  assert.equal(list.pages.find((p: any) => p.isProfile).body, "Lives in Amsterdam with Sam.\nPrefers tea.");
  assert.deepEqual(list.deleted.map((d: any) => d.name).sort(), ["Car", "Old car"]);
  const anouk = rows("SELECT * FROM brain__pages WHERE name = 'Anouk'")[0];
  assert.deepEqual([anouk.created_at, anouk.updated_at, anouk.deleted_at, anouk.type], [at("01-02"), at("09-01"), null, "person"]);
  const revs = rows("SELECT author, note, created_at FROM brain__revisions WHERE page_id = ?", anouk.id);
  assert.deepEqual(revs, [{ author: "user", note: `imported from jarvis (created ${at("01-02")}, updated ${at("09-01")})`, created_at: "2026-09-30T10:00:00.000Z" }]);
  assert.equal(rows("SELECT * FROM brain__revisions WHERE page_id = (SELECT id FROM brain__pages WHERE name = 'Old car')").length, 1, "a deleted page has one revision too");
  assert.equal(rows("SELECT deleted_at FROM brain__pages WHERE name = 'Old car'")[0].deleted_at, at("01-06"));
  assert.deepEqual(rows("SELECT key, purged_at FROM brain__tombstones ORDER BY key"), [{ key: "acme", purged_at: at("04-01") }, { key: "ex", purged_at: at("04-02") }, { key: "old job", purged_at: at("04-01") }]);
  // Links resolve, and the alias works.
  const family = list.pages.find((p: any) => p.name === "Family");
  const detail = (await h.request("GET", `pages/${family.id}`)).body as any;
  assert.deepEqual(detail.links.map((l: any) => [l.target, !!l.pageId]), [["Anouk", true], ["Bram", false]]);
  assert.equal(((await h.call("brain_recall", { entity: "noukie", query: "sister" })).result as { pages: { name: string }[] }).pages[0]!.name, "Anouk");
});

test("an imported tombstone keeps the name forgotten", async () => {
  const { h, post } = await host();
  await post({ ...sample(), dryRun: false });
  const r = (await h.call("brain_remember", { entity: "Old job", fact: "Boss was Kees" })).result;
  assert.deepEqual(r, { stored: false, reason: "tombstoned", message: "this was deliberately forgotten; the user can recreate it in the portal" });
});

test("an import into a brain that isn't empty is refused with 409 not_empty", async () => {
  const { h, post, rows } = await host();
  await h.request("POST", "pages", { name: "Anouk" });
  for (const dryRun of [true, false]) {
    const r = await post({ ...sample(), dryRun });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "not_empty");
  }
  assert.equal(rows("SELECT * FROM brain__pages").length, 2);
  // A profile with text counts as not empty, and so does a deleted page.
  const other = await host();
  await other.h.request("PUT", "pages/profile", { name: "Profile", type: "other", aliases: [], body: "Already here", baseRevision: 1 });
  assert.equal((await other.post({ ...sample(), dryRun: true })).status, 409);
});

test("invalid entries are reported with the pages involved, and a real import writes nothing", async () => {
  const { post, rows } = await host();
  const exp = sample();
  exp.pages!.push({ name: "x".repeat(120), type: "person", aliases: [], body: "", createdAt: at("01-01"), updatedAt: at("01-01") });
  exp.pages!.push({ name: "Sister", type: "person", aliases: ["noukie"], body: "", createdAt: at("01-01"), updatedAt: at("01-01") });
  exp.pages!.push({ name: "Big", type: "other", aliases: [], body: "b".repeat(20001), createdAt: at("01-01"), updatedAt: at("01-01") });
  exp.pages!.push({ name: "Robot", type: "animal", aliases: [], body: "", createdAt: at("01-01"), updatedAt: "" });
  const dry = await post({ ...exp, dryRun: true });
  const problems = dry.body.report.problems.map((p: any) => `${p.page}: ${p.message}`);
  assert.equal(problems.length, 5);
  assert.match(problems.join("\n"), /x{120}: name must be 1 to 80 characters/);
  assert.match(problems.join("\n"), /Sister: "noukie" is also a name or alias of Anouk/);
  assert.match(problems.join("\n"), /Big: body may be at most 20000 characters/);
  assert.match(problems.join("\n"), /Robot: type must be one of/);
  assert.match(problems.join("\n"), /Robot: missing or invalid updatedAt/);
  const real = await post({ ...exp, dryRun: false });
  assert.equal(real.status, 400);
  assert.equal(real.body.code, "invalid");
  assert.equal(real.body.report.problems.length, 5);
  assert.equal(rows("SELECT * FROM brain__pages").length, 1, "nothing written");
});

test("warnings don't block: dropped aliases, a skipped tombstone, links Friday won't recognise, an over-budget profile", async () => {
  const { post, rows } = await host();
  const exp = sample();
  exp.pages![0]!.aliases = ["car", "Volvo", "volvo"];
  exp.pages![1]!.body = `See [[${"n".repeat(90)}]] and [[Family]].`;
  exp.tombstones!.push({ name: "Anouk", purgedAt: at("01-01") });
  exp.profile!.body = "p".repeat(4000);
  const r = await post({ ...exp, dryRun: false });
  assert.equal(r.body.applied, true);
  const warnings = r.body.report.warnings.map((w: any) => `${w.page}: ${w.message}`).join("\n");
  assert.match(warnings, /Car: 2 duplicate alias\(es\) dropped/);
  assert.match(warnings, /Anouk: the forgotten name "Anouk" is used again by Anouk; that tombstone is skipped/);
  assert.match(warnings, /isn't a link under Friday's rules/);
  assert.match(warnings, /Profile: the profile is about 1000 tokens, over its budget of 800/);
  assert.deepEqual(rows("SELECT key FROM brain__tombstones WHERE key = 'anouk'"), []);
  assert.deepEqual(JSON.parse(rows("SELECT aliases_json FROM brain__pages WHERE name = 'Car' AND deleted_at IS NULL")[0].aliases_json), ["Volvo"]);
});

test("the prompt index lists imported pages in Jarvis's recency order", async () => {
  const { h, post } = await host();
  await post({ ...sample(), dryRun: false });
  const index = h.promptContext("voice").split("\n").filter((l) => l.startsWith("- "));
  const names = index.map((l) => l.slice(2).split(" (")[0]);
  assert.deepEqual(names.slice(0, 3), ["Anouk", "Family", "Page 9"]);
  assert.ok(names.indexOf("Anouk") < names.indexOf("Car"), "Anouk (updated in September) before Car (updated in February)");
});

test("deleted pages go in before the profile and live pages, so they may reuse their names", async () => {
  const { post, rows } = await host();
  const exp = sample();
  exp.profile!.aliases = ["Me"];
  exp.deleted!.push({ name: "Me", type: "person", aliases: ["Noukie"], body: "old", createdAt: at("01-01"), updatedAt: at("01-01"), deletedAt: at("01-02") });
  const r = await post({ ...exp, dryRun: false });
  assert.equal(r.body.applied, true, JSON.stringify(r.body.report.problems));
  assert.equal(rows("SELECT key FROM brain__names WHERE key IN ('me', 'noukie')").length, 2);
  assert.equal(rows("SELECT deleted_at FROM brain__pages WHERE name = 'Me'")[0].deleted_at, at("01-02"));
});

test("times are stored as UTC ISO strings, whatever offset Jarvis wrote", async () => {
  const { post, rows } = await host();
  const exp = sample();
  exp.pages![0]!.createdAt = "2026-01-01T12:00:00+02:00";
  exp.pages![0]!.updatedAt = "2026-02-01T12:00:00Z";
  assert.equal((await post({ ...exp, dryRun: false })).body.applied, true);
  const car = rows("SELECT created_at, updated_at FROM brain__pages WHERE name = 'Car' AND deleted_at IS NULL")[0];
  assert.deepEqual([car.created_at, car.updated_at], ["2026-01-01T10:00:00.000Z", at("02-01")]);
});

test("malformed entries and a malformed profile are problems, not errors", async () => {
  const { post } = await host();
  const r = await post({ profile: "text", pages: [null, "Car"], deleted: [7], tombstones: [{ purgedAt: at("01-01") }], dryRun: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.report.problems.map((p: any) => p.page), ["Profile", "(pages)", "(pages)", "(deleted)", "(tombstones)"]);
});

test("a collision is reported even when the other page has problems of its own", async () => {
  const { post } = await host();
  const exp = sample();
  exp.pages!.push({ name: "Robot", type: "animal", aliases: ["Noukie"], body: "", createdAt: at("01-01"), updatedAt: at("01-01") });
  exp.pages!.push({ name: "robot", type: "other", aliases: [], body: "", createdAt: at("01-01"), updatedAt: at("01-01") });
  const problems = (await post({ ...exp, dryRun: true })).body.report.problems.map((p: any) => `${p.page}: ${p.message}`).join("\n");
  assert.match(problems, /Robot: type must be one of/);
  assert.match(problems, /Robot: "Noukie" is also a name or alias of Anouk/);
  assert.match(problems, /robot: "robot" is also a name or alias of Robot/);
});

test("a profile with aliases counts as not empty", async () => {
  const { h, post } = await host();
  await h.request("PUT", "pages/profile", { name: "Profile", type: "other", aliases: ["Me"], body: "", baseRevision: 1 });
  assert.equal((await post({ ...sample(), dryRun: true })).status, 409);
});

test("an imported page that brings back a name this brain forgot is a warning", async () => {
  const { h, post } = await host();
  const page = (await h.request("POST", "pages", { name: "Anouk" })).body as any;
  await h.request("DELETE", `pages/${page.id}`);
  await h.request("POST", `pages/${page.id}/purge`, { confirm: "Anouk" });
  const r = await post({ ...sample(), dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.report.warnings.map((w: any) => w.message).join("\n"), /"Anouk" was deliberately forgotten in this brain; importing Anouk brings the name back/);
});

test("a store error inside the transaction rolls everything back and is reported as a problem", () => {
  const { store, db } = brainStore();
  const create = store.create.bind(store);
  let n = 0;
  store.create = (...a) => {
    if (++n === 3) throw new BrainError("name_taken", "that name is taken", undefined, ["Family"]);
    return create(...a);
  };
  const r = runImport(store, db, sample(), 800, false);
  assert.equal(r.applied, false);
  assert.deepEqual(r.report.problems, [{ page: "Family", message: "the import failed and was rolled back: that name is taken" }]);
  assert.equal(store.count(), 0);
  assert.equal(store.deleted().length, 0);
  assert.equal(store.profile().body, "");
});

test("a malformed body is 400", async () => {
  const { post } = await host();
  assert.equal((await post("nope")).status, 400);
  const r = await post({ pages: "nope", dryRun: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.report.problems, [{ page: "(export)", message: "pages must be a list" }]);
});
