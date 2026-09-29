import { test } from "node:test";
import assert from "node:assert/strict";
import { nameKey } from "../src/links.js";
import { BrainError, validateFields, type BrainErrorCode } from "../src/store.js";
import { brainStore, rows } from "./fixtures.js";

const code = (c: BrainErrorCode, match?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof BrainError, String(e));
  assert.equal(e.code, c);
  if (match) assert.match(e.message, match);
  return true;
};

// ---- 2.1 names, validation, errors ----

test("name keys: NFC, trimmed, whitespace collapsed, lower-cased", () => {
  assert.equal(nameKey("  Anouk   de\tWit "), "anouk de wit");
  assert.equal(nameKey("Café"), nameKey("Café"));
  assert.equal(nameKey("ANOUK"), "anouk");
});

test("field validation: names and aliases", () => {
  assert.deepEqual(validateFields({ name: "  Anouk  de Wit ", type: "person" }), { name: "Anouk de Wit", type: "person", aliases: [], body: "" });
  assert.throws(() => validateFields({ name: "" }), code("invalid", /1 to 80/));
  assert.throws(() => validateFields({ name: "x".repeat(81) }), code("invalid", /1 to 80/));
  assert.doesNotThrow(() => validateFields({ name: "x".repeat(80) }));
  assert.throws(() => validateFields({ name: "two\nlines" }), code("invalid", /line break/));
  assert.throws(() => validateFields({ name: "a [[b]]" }), code("invalid", /\[\[ or \]\]/));
  assert.throws(() => validateFields({ name: "Profile" }), code("invalid", /reserved/));
  assert.throws(() => validateFields({ name: "Anouk", aliases: ["profile"] }), code("invalid", /reserved/));
  assert.doesNotThrow(() => validateFields({ name: "Profile" }, true));
  assert.throws(() => validateFields({ name: "Anouk", aliases: ["ok", "bad\nalias"] }), code("invalid", /alias may not contain a line break/));
});

test("field validation: aliases are deduplicated, never the name, and at most 20", () => {
  assert.deepEqual(validateFields({ name: "Anouk", aliases: ["Noukie", "noukie ", "ANOUK", "Nouk"] }).aliases, ["Noukie", "Nouk"]);
  const twenty = Array.from({ length: 20 }, (_, i) => `a${i}`);
  assert.equal(validateFields({ name: "x", aliases: twenty }).aliases.length, 20);
  assert.throws(() => validateFields({ name: "x", aliases: [...twenty, "a20"] }), code("invalid", /at most 20 aliases/));
});

test("field validation: body size and type", () => {
  assert.doesNotThrow(() => validateFields({ name: "x", body: "b".repeat(20000) }));
  assert.throws(() => validateFields({ name: "x", body: "b".repeat(20001) }), code("invalid", /20000/));
  assert.throws(() => validateFields({ name: "x", type: "animal" as never }), code("invalid", /type must be one of person, place, project, other/));
  assert.equal(validateFields({ name: "x" }).type, "other");
});

// ---- 2.2 writes ----

test("create records a user revision and claims the names", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Anouk", type: "person", aliases: ["Noukie"], body: "Sister" }, "user");
  assert.equal(p.name, "Anouk");
  assert.equal(p.isProfile, false);
  assert.deepEqual(store.revisions(p.id).map((r) => r.author), ["user"]);
  assert.deepEqual(store.revision(p.id, p.revisionId)?.body, "Sister");
  assert.deepEqual(rows(db.prepare("SELECT key, kind FROM brain__names WHERE page_id = ? ORDER BY key").all(p.id)), [{ key: "anouk", kind: "name" }, { key: "noukie", kind: "alias" }]);
  assert.equal(store.resolve("NOUKIE")?.id, p.id);
});

test("an alias colliding with another page's name is name_taken, naming it", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.create({ name: "Anouk", type: "person" }, "user");
  const other = store.create({ name: "Sister" }, "user");
  assert.throws(() => store.save(other.id, { ...other, aliases: ["anouk"] }, "user"), (e) => code("name_taken", /anouk/)(e) && (e as BrainError).names![0] === "anouk");
  assert.throws(() => store.create({ name: "ANOUK " }, "user"), code("name_taken"));
});

test("a save based on an old revision is stale and carries the current page", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Anouk", body: "v1" }, "user");
  const v2 = store.save(p.id, { ...p, body: "v2" }, "remember");
  assert.throws(() => store.save(p.id, { ...p, body: "mine" }, "user", { base: p.revisionId }), (e) => {
    code("stale")(e);
    assert.equal((e as BrainError).current?.revisionId, v2.revisionId);
    assert.equal((e as BrainError).current?.body, "v2");
    return true;
  });
  assert.equal(store.save(p.id, { ...p, body: "mine" }, "user", { base: v2.revisionId }).body, "mine");
});

test("a rename keeps the old name as an alias unless the save opts out", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Anouk", type: "person" }, "user");
  const renamed = store.save(p.id, { ...p, name: "Anouk de Wit" }, "user");
  assert.deepEqual(renamed.aliases, ["Anouk"]);
  assert.equal(store.resolve("anouk")?.id, p.id);
  const again = store.save(p.id, { ...renamed, name: "A. de Wit", aliases: [] }, "user", { keepOldName: false });
  assert.deepEqual(again.aliases, []);
  assert.equal(store.resolve("Anouk de Wit"), undefined);
});

test("a rename that can't keep the old name as a 21st alias says so", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Anouk", aliases: Array.from({ length: 20 }, (_, i) => `a${i}`) }, "user");
  assert.throws(() => store.save(p.id, { ...p, name: "Anouk de Wit" }, "user"), code("invalid", /renaming keeps "Anouk" as an alias, but the page already has 20/));
  assert.equal(store.save(p.id, { ...p, name: "Anouk de Wit" }, "user", { keepOldName: false }).name, "Anouk de Wit");
});

test("revision ids keep increasing after a purge deletes the newest ones", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const keep = store.create({ name: "Keep" }, "user");
  const gone = store.create({ name: "Gone" }, "user");
  store.save(gone.id, { ...gone, body: "more" }, "user");
  store.softDelete(gone.id, "user");
  const highest = store.get(gone.id)!.revisionId;
  store.purge(gone.id, "Gone", "user");
  const next = store.save(keep.id, { ...keep, body: "after the purge" }, "user");
  assert.ok(next.revisionId > highest, `${next.revisionId} > ${highest}`);
});

test("the profile can't be renamed, retyped or deleted", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const profile = store.profile();
  assert.throws(() => store.save(profile.id, { ...profile, name: "Me" }, "user"), code("profile"));
  assert.throws(() => store.save(profile.id, { ...profile, type: "person" }, "user"), code("profile"));
  assert.throws(() => store.softDelete(profile.id, "user"), code("profile"));
  assert.equal(store.save(profile.id, { ...profile, body: "Lives in Amsterdam", aliases: ["Household"] }, "user").body, "Lives in Amsterdam");
  assert.equal(store.profile().name, "Profile");
});

test("a tombstoned name is refused for non-user writes; a user create lifts it", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  const old = store.create({ name: "Old job", aliases: ["Acme"] }, "user");
  store.softDelete(old.id, "user");
  store.purge(old.id, "Old job", "user");
  assert.deepEqual(rows(db.prepare("SELECT key FROM brain__tombstones ORDER BY key").all()), [{ key: "acme" }, { key: "old job" }]);
  assert.throws(() => store.create({ name: "Old job" }, "extraction"), code("tombstoned"));
  const other = store.create({ name: "Work" }, "user");
  assert.throws(() => store.save(other.id, { ...other, aliases: ["acme"] }, "consolidation"), code("tombstoned", /Acme/));
  const recreated = store.create({ name: "Old job" }, "user");
  assert.equal(recreated.name, "Old job");
  assert.deepEqual(rows(db.prepare("SELECT key FROM brain__tombstones").all()), [{ key: "acme" }]);
  assert.equal(store.save(recreated.id, { ...recreated, body: "back" }, "remember").body, "back");
});

test("a failing write leaves no partial rows", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  store.create({ name: "Anouk" }, "user");
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const before = ["brain__pages", "brain__names", "brain__revisions"].map(count);
  assert.throws(() => store.create({ name: "Sister", aliases: ["Nouk", "anouk"] }, "user"), code("name_taken"));
  assert.throws(() => store.create({ name: "x", body: "b".repeat(20001) }, "user"), code("invalid"));
  assert.throws(() => store.create({ name: "y" }, "robot" as never), code("invalid", /unknown author/));
  assert.deepEqual(["brain__pages", "brain__names", "brain__revisions"].map(count), before);
});

test("writes to a missing or deleted page are not_found", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  assert.throws(() => store.save("nope", { name: "x" }, "user"), code("not_found"));
  const p = store.create({ name: "Car" }, "user");
  store.softDelete(p.id, "user");
  assert.throws(() => store.save(p.id, { name: "Car" }, "user"), code("not_found", /deleted/));
});

// ---- 2.3 restore, delete, undelete, purge ----

test("restore makes an old revision current as a new user revision and keeps the history", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Anouk", body: "v1" }, "user");
  const v1 = p.revisionId;
  let cur = p;
  for (const body of ["v2", "v3", "v4"]) cur = store.save(p.id, { ...cur, body }, "user");
  const restored = store.restore(p.id, v1, "user", cur.revisionId);
  assert.equal(restored.body, "v1");
  const history = store.revisions(p.id);
  assert.equal(history.length, 5);
  assert.deepEqual(history[0], { id: restored.revisionId, author: "user", createdAt: history[0]!.createdAt, note: `restored revision ${v1}`, sources: [] });
  assert.throws(() => store.restore(p.id, v1, "user", cur.revisionId), code("stale"));
  assert.throws(() => store.restore(p.id, 999, "user"), code("not_found"));
});

test("delete frees the names and undelete brings the page back with its history", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Anouk", aliases: ["Noukie"], body: "Sister" }, "user");
  const deleted = store.softDelete(p.id, "user");
  assert.ok(deleted.deletedAt);
  assert.equal(store.resolve("Noukie"), undefined);
  assert.deepEqual(store.list().map((x) => x.name), ["Profile"]);
  assert.deepEqual(store.deleted().map((x) => x.name), ["Anouk"]);
  const back = store.undelete(p.id, "user");
  assert.equal(back.deletedAt, undefined);
  assert.equal(store.resolve("noukie")?.id, p.id);
  assert.deepEqual(store.revisions(p.id).map((r) => r.note ?? "-"), ["undeleted", "deleted", "-"]);
});

test("undelete is refused when a live page took one of its names", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const first = store.create({ name: "Old car" }, "user");
  store.softDelete(first.id, "user");
  const second = store.create({ name: "Old car" }, "user");
  assert.ok(second.id !== first.id);
  assert.throws(() => store.undelete(first.id, "user"), (e) => code("name_taken", /Old car/)(e) && (e as BrainError).names![0] === "Old car");
  assert.ok(store.get(first.id)?.deletedAt, "still deleted");
});

test("purge tombstones the names, unlinks inbound links and deletes the page with its revisions", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  const profile = store.save("profile", { ...store.profile(), body: "Worked at [[Old job]] for years. Lives near [[Utrecht]]." }, "user");
  const job = store.create({ name: "Old job", aliases: ["Acme"], body: "Office in town" }, "user");
  const family = store.create({ name: "Family", body: "Met at [[acme]]." }, "user");
  store.softDelete(job.id, "user");
  // A live page took one of the names meanwhile: that name stays linked and isn't tombstoned.
  store.create({ name: "Acme" }, "user");
  const unlinked = store.purge(job.id, "Old job", "user");
  assert.deepEqual(unlinked, ["Profile"]);
  assert.equal(store.get(job.id), undefined);
  assert.equal(rows(db.prepare("SELECT * FROM brain__revisions WHERE page_id = ?").all(job.id)).length, 0);
  assert.equal(store.profile().body, "Worked at Old job for years. Lives near [[Utrecht]].");
  assert.deepEqual(store.revisions("profile")[0], { id: store.profile().revisionId, author: "user", createdAt: store.revisions("profile")[0]!.createdAt, note: 'unlinked "Old job" after purge', sources: [] });
  assert.ok(store.profile().revisionId > profile.revisionId);
  assert.equal(store.get(family.id)?.body, "Met at [[acme]].");
  assert.deepEqual(rows(db.prepare("SELECT key, name FROM brain__tombstones").all()), [{ key: "old job", name: "Old job" }]);
});

test("purge of a live page or with a wrong confirmation is refused and changes nothing", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  const p = store.create({ name: "Old job" }, "user");
  assert.throws(() => store.purge(p.id, "Old job", "user"), code("not_deleted"));
  store.softDelete(p.id, "user");
  assert.throws(() => store.purge(p.id, "old job", "user"), code("invalid", /type the page's name/));
  assert.throws(() => store.purge(p.id, undefined, "user"), code("invalid"));
  assert.ok(store.get(p.id));
  assert.equal(rows(db.prepare("SELECT * FROM brain__tombstones").all()).length, 0);
  assert.throws(() => store.purge("nope", "x", "user"), code("not_found"));
});
