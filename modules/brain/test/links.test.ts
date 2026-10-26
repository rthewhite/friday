import { test } from "node:test";
import assert from "node:assert/strict";
import { autolink, parseLinks, unlink } from "../src/links.js";
import { brainStore } from "./fixtures.js";

test("parseLinks finds targets with their line, cut to 160 characters", () => {
  const long = `Intro ${"x".repeat(200)} [[Far]]`;
  const links = parseLinks(`# Family\n- Sister: [[Anouk]] and [[ Bram ]]\n${long}\n[[not\nclosed]] [[]]`);
  assert.deepEqual(links.slice(0, 2), [
    { target: "Anouk", line: "- Sister: [[Anouk]] and [[ Bram ]]" },
    { target: "Bram", line: "- Sister: [[Anouk]] and [[ Bram ]]" },
  ]);
  assert.equal(links[2]!.target, "Far");
  assert.equal(links[2]!.line.length, 160);
  assert.ok(links[2]!.line.endsWith("…"));
  assert.equal(links.length, 3);
});

test("a page reports a backlink with its line, resolved through an alias", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const anouk = store.create({ name: "Anouk", aliases: ["Noukie"], type: "person" }, "user");
  store.create({ name: "Family", body: "Intro\n- Sister: [[Anouk]]" }, "user");
  store.create({ name: "Holidays", body: "Went with [[noukie]] to Texel" }, "user");
  assert.deepEqual(store.backlinks(anouk).map(({ name, line }) => ({ name, line })), [
    { name: "Holidays", line: "Went with [[noukie]] to Texel" },
    { name: "Family", line: "- Sister: [[Anouk]]" },
  ]);
  const holidays = store.resolve("Holidays")!;
  assert.deepEqual(store.links(holidays), [{ target: "noukie", line: "Went with [[noukie]] to Texel", pageId: anouk.id, pageName: "Anouk" }]);
});

test("a link to nothing is dangling; links in deleted pages are ignored", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const home = store.create({ name: "Home", body: "In [[Utrecht]]" }, "user");
  assert.deepEqual(store.links(home), [{ target: "Utrecht", line: "In [[Utrecht]]" }]);
  const utrecht = store.create({ name: "Utrecht", type: "place" }, "user");
  assert.equal(store.links(home)[0]!.pageId, utrecht.id);
  assert.equal(store.backlinks(utrecht).length, 1);
  store.softDelete(home.id, "user");
  assert.deepEqual(store.backlinks(utrecht), []);
  // A deleted target no longer resolves.
  const trip = store.create({ name: "Trip", body: "Via [[Utrecht]]" }, "user");
  store.softDelete(utrecht.id, "user");
  assert.equal(store.links(trip)[0]!.pageId, undefined);
});

test("links inside code spans and fenced blocks are not links, as on the rendered page", (t) => {
  const body = "Real [[Anouk]] and `[[Code]]` and ``a ` [[Tick]]``\n```\n[[Fenced]]\n```\n~~~js\n[[Tilde]]\n~~~\nUnclosed ` [[After]]";
  assert.deepEqual(parseLinks(body).map((l) => l.target), ["Anouk", "After"]);
  assert.equal(unlink(body, new Set(["code", "fenced", "anouk", "tilde", "tick"])), body.replace("[[Anouk]]", "Anouk"));
  const { store, close } = brainStore();
  t.after(close);
  const job = store.create({ name: "Old job" }, "user");
  store.create({ name: "Notes", body: "`[[Old job]]` is a code sample" }, "user");
  assert.deepEqual(store.backlinks(job), []);
  store.softDelete(job.id, "user");
  assert.deepEqual(store.purge(job.id, "Old job", "user"), []);
});

test("unlink rewrites only the given names and leaves other links intact", () => {
  const body = "Worked at [[Old job]] and [[old  JOB]], lives in [[Utrecht]].";
  assert.equal(unlink(body, new Set(["old job"])), "Worked at Old job and old  JOB, lives in [[Utrecht]].");
  assert.equal(unlink(body, new Set()), body);
});

// ---- hybrid-profile: links added by code ----

const n = (name: string, pageId = name) => ({ name, pageId });

test("autolink links the first whole-word, same-case mention of each page", () => {
  assert.equal(autolink("Lives at Home in Almere. Home is warm.", [n("Home")]), "Lives at [[Home]] in Almere. Home is warm.");
  // Lowercase is a word, not the page; inside another word isn't a mention either.
  assert.equal(autolink("Works from home on Fridays, at Homeland too.", [n("Home")]), "Works from home on Fridays, at Homeland too.");
  // Accented letters count as letters for the word boundary.
  assert.equal(autolink("Café Cafébar and Café", [n("Café")]), "[[Café]] Cafébar and Café");
});

test("autolink: longest name first, no overlap, one link per page across its names", () => {
  assert.equal(autolink("Restoring the Honda CB900F; the Honda is old.", [n("Honda", "h"), n("Honda CB900F", "cb")]), "Restoring the [[Honda CB900F]]; the [[Honda]] is old.");
  assert.equal(autolink("Noukie and Anouk", [n("Anouk", "a"), n("Noukie", "a")]), "[[Noukie]] and Anouk");
});

test("autolink skips short names, already linked pages, existing links and code", () => {
  assert.equal(autolink("Me and Lisa went to Utrecht", [n("Me"), n("Lisa")]), "Me and [[Lisa]] went to Utrecht");
  assert.equal(autolink("Lisa again", [n("Lisa", "l")], new Set(["l"])), "Lisa again");
  assert.equal(autolink("[[Lisa de Wit]] and Lisa", [n("Lisa", "l")]), "[[Lisa de Wit]] and [[Lisa]]");
  assert.equal(autolink("`Lisa` and\n```\nLisa\n```\nLisa", [n("Lisa")]), "`Lisa` and\n```\nLisa\n```\n[[Lisa]]");
});

test("the store links nightly writes in full, remembered notes only in the note, and user writes never", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const home = store.create({ name: "Home", type: "place" }, "user");
  store.create({ name: "Schuberg Philis", type: "other" }, "user");
  // A user's own mention stays as typed.
  const lisa = store.create({ name: "Lisa", type: "person", body: "Lives at Home." }, "user");
  assert.equal(lisa.body, "Lives at Home.");
  // remember links only the new note, not the user's earlier text.
  store.appendNote("Lisa", "Works at Schuberg Philis near Home", undefined, "2026-09-29");
  assert.equal(store.get(lisa.id)!.body, "Lives at Home.\n\n## Notes\n- 2026-09-29: Works at [[Schuberg Philis]] near [[Home]]");
  // The same fact again is still recognised, links or not.
  assert.equal(store.appendNote("Lisa", "Works at Schuberg Philis near Home", undefined, "2026-09-29").stored, false);
  // A page already linking a target gets no second link.
  const fam = store.create({ name: "Family", body: "See [[Lisa]]." }, "user");
  store.appendNote("Family", "Lisa likes tea", undefined, "2026-09-29");
  assert.equal(store.get(fam.id)!.body, "See [[Lisa]].\n\n## Notes\n- 2026-09-29: Lisa likes tea");
  // A consolidation rewrite and the summary are linked in full; the page never links itself.
  const rewritten = store.save(home.id, { ...store.get(home.id)!, body: "Home is in Almere. Lisa lives here." }, "consolidation");
  assert.equal(rewritten.body, "Home is in Almere. [[Lisa]] lives here.");
  assert.equal(store.writeSummary("Lives at Home in Almere. Works at Schuberg Philis.", "consolidation").body, "Lives at [[Home]] in Almere. Works at [[Schuberg Philis]].");
  // A user's save keeps the text as typed.
  assert.equal(store.save(home.id, { ...store.get(home.id)!, body: "Lisa and Schuberg Philis" }, "user").body, "Lisa and Schuberg Philis");
});
