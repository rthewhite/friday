import { test } from "node:test";
import assert from "node:assert/strict";
import { extraScopes, overrides } from "../src/lib/config-stored.ts";

const at = (...scopes: string[]) => scopes.map((scope) => ({ scope }));

test("a key stored once has no extra scopes and no overrides", () => {
  const e = { scope: "global", stored: at("global") };
  assert.equal(extraScopes(e), 0);
  assert.deepEqual(overrides(e), []);
});

test("an unstored key has neither", () => {
  assert.equal(extraScopes({}), 0);
  assert.deepEqual(overrides({}), []);
});

test("global plus a module: one extra scope, and the module overrides global", () => {
  const e = { scope: "global", stored: at("global", "builtin") };
  assert.equal(extraScopes(e), 1);
  assert.deepEqual(overrides(e), ["builtin"]);
});

test("a module value without a global one overrides nothing", () => {
  assert.deepEqual(overrides({ scope: "brain", stored: at("brain") }), []);
  assert.deepEqual(overrides({ scope: "brain", stored: at("brain", "travel") }), []);
});

test("core next to global is not a module override", () => {
  const e = { scope: "global", stored: at("global", "core", "travel") };
  assert.equal(extraScopes(e), 2);
  assert.deepEqual(overrides(e), ["travel"]);
});
