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

test("the profile can't be renamed, retyped, deleted, or have its summary edited", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const profile = store.profile();
  assert.throws(() => store.save(profile.id, { ...profile, name: "Me" }, "user"), code("profile"));
  assert.throws(() => store.save(profile.id, { ...profile, type: "person" }, "user"), code("profile"));
  assert.throws(() => store.softDelete(profile.id, "user"), code("profile"));
  assert.throws(() => store.save(profile.id, { ...profile, body: "Lives in Amsterdam" }, "user"), code("profile", /generated/));
  assert.throws(() => store.save(profile.id, { ...profile, aliases: ["Household"] }, "user"), code("profile"));
  assert.throws(() => store.save(profile.id, { ...profile, body: "Lives in Amsterdam" }, "consolidation"), code("profile"));
  assert.deepEqual({ name: store.profile().name, body: store.profile().body, revisionId: store.profile().revisionId }, { name: "Profile", body: "", revisionId: profile.revisionId });
});

// ---- hybrid-profile: the subject page, instructions and the summary ----

test("the subject page can't be deleted or retyped, and only the user renames it, keeping the old name as an alias", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const me = store.subject();
  assert.equal(me.name, "Me");
  assert.equal(me.type, "person");
  assert.equal(store.profile().subjectId, me.id);
  assert.throws(() => store.softDelete(me.id, "user"), code("profile"));
  assert.throws(() => store.save(me.id, { ...me, type: "other" }, "user"), code("profile"));
  assert.throws(() => store.save(me.id, { ...me, name: "Raymond" }, "consolidation"), code("profile", /only the user/));
  assert.equal(store.save(me.id, { ...me, body: "Plays iRacing" }, "consolidation").body, "Plays iRacing");
  const renamed = store.save(me.id, { ...store.subject(), name: "Raymond" }, "user");
  assert.deepEqual({ name: renamed.name, aliases: renamed.aliases }, { name: "Raymond", aliases: ["Me"] });
  assert.equal(store.subject().id, me.id);
  assert.equal(store.resolve("me")?.id, me.id);
});

test("instructions: saved by the user up to 2000 characters, snapshotted in every profile revision", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const base = store.profile().revisionId;
  const saved = store.saveInstructions("Call me Ray. In voice, keep answers short.", base);
  assert.equal(saved.instructions, "Call me Ray. In voice, keep answers short.");
  assert.deepEqual(store.revisions("profile")[0]!.author, "user");
  assert.equal(store.revision("profile", saved.revisionId)?.instructions, "Call me Ray. In voice, keep answers short.");
  // A summary write keeps the instructions, and its revision holds both parts.
  const summary = store.writeSummary("Lives in Almere.", "consolidation");
  assert.deepEqual({ body: summary.body, instructions: summary.instructions }, { body: "Lives in Almere.", instructions: "Call me Ray. In voice, keep answers short." });
  const rev = store.revision("profile", summary.revisionId)!;
  assert.deepEqual({ body: rev.body, instructions: rev.instructions, author: rev.author }, { body: "Lives in Almere.", instructions: "Call me Ray. In voice, keep answers short.", author: "consolidation" });
  // Other pages have no instructions.
  assert.equal(store.revision(store.subject().id, store.subject().revisionId)?.instructions, undefined);
  // Too long.
  assert.throws(() => store.saveInstructions("x".repeat(2001), summary.revisionId), code("invalid", /2000/));
  assert.throws(() => store.saveInstructions(42, summary.revisionId), code("invalid"));
  assert.doesNotThrow(() => store.saveInstructions("x".repeat(2000), summary.revisionId));
});

test("instructions: a summary written meanwhile doesn't make a save stale; other instructions do", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const opened = store.profile().revisionId;
  store.writeSummary("Lives in Almere.", "consolidation");
  const saved = store.saveInstructions("Call me Ray.", opened);
  assert.deepEqual({ body: saved.body, instructions: saved.instructions }, { body: "Lives in Almere.", instructions: "Call me Ray." });
  // A second tab, opened before that save, is stale and gets the current profile back.
  assert.throws(() => store.saveInstructions("Answer in Dutch.", opened), (e) => code("stale")(e) && (e as BrainError).current?.instructions === "Call me Ray.");
  assert.throws(() => store.saveInstructions("Answer in Dutch.", 99999), code("stale"));
  assert.equal(store.profile().instructions, "Call me Ray.");
});

test("instructions: restoring a revision brings back its instructions and keeps the current summary", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const first = store.saveInstructions("Call me Ray.", store.profile().revisionId);
  const second = store.saveInstructions("Answer in Dutch.", first.revisionId);
  store.writeSummary("Lives in Almere.", "consolidation");
  const restored = store.restoreInstructions(first.revisionId, second.revisionId);
  assert.deepEqual({ body: restored.body, instructions: restored.instructions }, { body: "Lives in Almere.", instructions: "Call me Ray." });
  assert.equal(store.revisions("profile")[0]!.note, `restored revision ${first.revisionId}`);
  assert.throws(() => store.restoreInstructions(999999, restored.revisionId), code("not_found"));
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
  assert.deepEqual(store.list().map((x) => x.name).sort(), ["Me", "Profile"]);
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
  const profile = store.writeSummary("Worked at [[Old job]] for years. Lives near [[Utrecht]].", "consolidation");
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
