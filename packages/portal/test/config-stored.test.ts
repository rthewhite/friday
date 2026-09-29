import { test } from "node:test";
import assert from "node:assert/strict";
import { ownCopies, scopeSummary, strayCopies } from "../src/lib/config-stored.ts";

const at = (...scopes: string[]) => scopes.map((scope) => ({ scope }));
const tz = { modules: at("core", "builtin", "brain", "travel").map(({ scope }) => ({ id: scope })) };

test("a key stored once shows its scope with nothing behind +N", () => {
  assert.deepEqual(scopeSummary({ ...tz, scope: "global", stored: at("global") }), { scope: "global", others: [] });
  assert.deepEqual(ownCopies({ ...tz, scope: "global", stored: at("global") }), []);
});

test("an unstored key shows the environment or nothing", () => {
  assert.deepEqual(scopeSummary({ status: "env" }), { scope: "environment", others: [] });
  assert.deepEqual(scopeSummary({ status: "pending" }), { scope: "", others: [] });
});

test("global plus a module: one other scope, and the module reads its own copy", () => {
  const e = { ...tz, scope: "global", stored: at("global", "builtin") };
  assert.deepEqual(scopeSummary(e), { scope: "global", others: ["builtin"] });
  assert.deepEqual(ownCopies(e), ["builtin"]);
});

test("a module-only copy is still an own copy, so saving global warns about it", () => {
  assert.deepEqual(ownCopies({ ...tz, scope: "builtin", stored: at("builtin") }), ["builtin"]);
});

test("core is a requester too: its copy wins over global for core", () => {
  assert.deepEqual(ownCopies({ ...tz, scope: "global", stored: at("global", "core", "travel") }), ["core", "travel"]);
});

test("a scope that does not request the key is a stray copy, not an override", () => {
  const e = { ...tz, scope: "global", stored: at("global", "gone") };
  assert.deepEqual(ownCopies(e), []);
  assert.deepEqual(strayCopies(e), ["gone"]);
});

test("without a winning scope the first stored copy stands in, never a bare +N", () => {
  assert.deepEqual(scopeSummary({ status: "pending", stored: at("global", "media") }), { scope: "global", others: ["media"] });
});
