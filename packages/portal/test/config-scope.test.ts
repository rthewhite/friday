import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultScope } from "../src/lib/config-scope.ts";

const requesters = (...ids: string[]) => ids.map((id) => ({ id }));

test("a shared key with nothing stored defaults to global", () => {
  assert.equal(defaultScope({ modules: requesters("core", "builtin", "brain", "travel") }), "global");
});

test("a key only one requester declares defaults to that requester", () => {
  assert.equal(defaultScope({ modules: requesters("media") }), "media");
  assert.equal(defaultScope({ modules: requesters("core") }), "core");
});

test("a stored value opens in the scope it is stored in", () => {
  assert.equal(defaultScope({ scope: "brain", modules: requesters("core", "builtin", "brain", "travel") }), "brain");
  assert.equal(defaultScope({ scope: "global", modules: requesters("media") }), "global");
});

test("an undeclared global value stays global", () => {
  assert.equal(defaultScope({ scope: "global", modules: [] }), "global");
  assert.equal(defaultScope({ modules: [] }), "global");
});
