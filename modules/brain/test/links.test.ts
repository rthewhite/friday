import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLinks, unlink } from "../src/links.js";
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

test("unlink rewrites only the given names and leaves other links intact", () => {
  const body = "Worked at [[Old job]] and [[old  JOB]], lives in [[Utrecht]].";
  assert.equal(unlink(body, new Set(["old job"])), "Worked at Old job and old  JOB, lives in [[Utrecht]].");
  assert.equal(unlink(body, new Set()), body);
});
