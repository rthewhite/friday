import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareMatches,
  inWindow,
  queryWords,
  searchableText,
  snippetsFor,
  SearchQueryError,
  validateSearch,
  type ConversationEntry,
} from "../src/index.js";

const at = "2026-09-20T10:00:00.000Z";
const user = (seq: number, text: string): ConversationEntry => ({ seq, at, kind: "user", input: "speech", text });
const friday = (seq: number, text: string): ConversationEntry => ({ seq, at, kind: "assistant", text, interrupted: false });
const tool = (seq: number, name: string, args: unknown, result?: unknown): ConversationEntry => ({ seq, at, kind: "tool", name, args, result, truncated: false });

test("queryWords folds, drops words under 3 characters and duplicates after folding", () => {
  assert.deepEqual(queryWords("Is de CV-ketel service booked? Café cafe"), ["ketel", "service", "booked", "cafe"]);
  assert.deepEqual(queryWords(undefined), []);
  assert.deepEqual(queryWords("a an of"), []);
});

test("validateSearch normalises instants and clamps the limit", () => {
  const s = validateSearch({ query: "boiler", since: "2026-09-15T02:00:00+02:00", limit: 99 });
  assert.deepEqual(s, { words: ["boiler"], since: "2026-09-15T00:00:00.000Z", exclude: [], limit: 20 });
  assert.equal(validateSearch().limit, 5);
  assert.equal(validateSearch({ limit: 0 }).limit, 5);
  assert.equal(validateSearch({ limit: -3 }).limit, 1);
});

test("validateSearch refuses an unknown channel, an invalid time and since after until", () => {
  assert.throws(() => validateSearch({ channel: "email" as never }), (e) => e instanceof SearchQueryError && /invalid channel: email/.test(e.message));
  assert.throws(() => validateSearch({ since: "last week" }), (e) => e instanceof SearchQueryError && /invalid since/.test(e.message));
  assert.throws(() => validateSearch({ until: "nope" }), /invalid until/);
  assert.throws(() => validateSearch({ since: "2026-09-20T00:00:00Z", until: "2026-09-19T00:00:00Z" }), /since is after until/);
  assert.doesNotThrow(() => validateSearch({ since: "2026-09-20T00:00:00Z", until: "2026-09-20T00:00:00Z" }));
});

test("inWindow is half-open", () => {
  const s = { since: "2026-09-20T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z" };
  assert.equal(inWindow("2026-09-20T00:00:00.000Z", s), true);
  assert.equal(inWindow("2026-09-20T23:59:59.999Z", s), true);
  assert.equal(inWindow("2026-09-21T00:00:00.000Z", s), false);
  assert.equal(inWindow("2026-09-19T23:59:59.999Z", s), false);
  assert.equal(inWindow("2020-01-01T00:00:00.000Z", {}), true);
});

test("searchableText holds text, or a tool's name and arguments but never its result", () => {
  assert.equal(searchableText(user(1, "hello")), "hello");
  assert.equal(searchableText(tool(2, "play_on_apple_tv", { title: "Dune" }, { playing: "Arrival" })), 'play_on_apple_tv {"title":"Dune"}');
});

test("a snippet is the matching entry with its neighbours, and a shown match starts no new one", () => {
  const entries = [user(1, "when is the boiler service?"), friday(2, "The boiler service is on Tuesday"), user(3, "thanks"), friday(4, "you're welcome"), user(5, "and the boiler key?"), friday(6, "under the mat")];
  const snippets = snippetsFor(entries, new Set([1, 2, 5]));
  assert.deepEqual(snippets.map((s) => s.map((e) => e.seq)), [[1, 2], [4, 5, 6]]);
});

test("the snippet around a match in the middle holds the entry before and after it", () => {
  const entries = [user(1, "when?"), friday(2, "The boiler service is on Tuesday"), user(3, "ok")];
  assert.deepEqual(snippetsFor(entries, new Set([2])).map((s) => s.map((e) => e.seq)), [[1, 2, 3]]);
});

test("at most 3 snippets, earliest first", () => {
  const entries = Array.from({ length: 20 }, (_, i) => user(i + 1, i % 4 === 0 ? "boiler" : "other"));
  const snippets = snippetsFor(entries, new Set(entries.filter((e) => e.kind === "user" && e.text === "boiler").map((e) => e.seq)));
  assert.deepEqual(snippets.map((s) => s.map((e) => e.seq)), [[1, 2], [4, 5, 6], [8, 9, 10]]);
});

test("without words, the single snippet is the first 3 entries", () => {
  const entries = [user(1, "a"), friday(2, "b"), user(3, "c"), friday(4, "d")];
  assert.deepEqual(snippetsFor(entries).map((s) => s.map((e) => e.seq)), [[1, 2, 3]]);
  assert.deepEqual(snippetsFor([]), []);
});

test("snippet text and tool arguments are cut to 300 characters, and tool results are never included", () => {
  const long = "x".repeat(500);
  const [[t, u]] = snippetsFor([tool(1, "note", { text: long }, { ok: true }), user(2, long)], new Set([1]));
  assert.equal(t.kind, "tool");
  if (t.kind === "tool") {
    assert.equal(typeof t.args, "string");
    assert.equal((t.args as string).length, 300);
    assert.equal("result" in t, false);
  }
  assert.equal(u.kind === "user" && u.text.length, 300);
  const [[small]] = snippetsFor([tool(1, "play", { title: "Dune" }, { secret: 1 })], new Set([1]));
  assert.deepEqual(small, { seq: 1, at, kind: "tool", name: "play", args: { title: "Dune" } });
});

test("compareMatches ranks by distinct words, then most recent activity", () => {
  const rows = [
    { id: "a", lastActivityAt: "2026-09-20T10:00:00.000Z", words: 1 },
    { id: "b", lastActivityAt: "2026-09-01T10:00:00.000Z", words: 2 },
    { id: "c", lastActivityAt: "2026-09-21T10:00:00.000Z", words: 1 },
  ];
  assert.deepEqual(rows.sort(compareMatches).map((r) => r.id), ["b", "c", "a"]);
});
