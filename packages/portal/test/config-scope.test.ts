import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultScope, defaultScopes, savePlan, toggleScope } from "../src/lib/config-scope.ts";

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

const stored = (...scopes: string[]) => scopes.map((scope) => ({ scope }));
const ha = requesters("media", "sonos");

test("preselection: nothing stored keeps the single-requester and shared-key defaults", () => {
  assert.deepEqual(defaultScopes({ modules: requesters("core", "builtin", "brain", "travel") }), ["global"]);
  assert.deepEqual(defaultScopes({ modules: requesters("media") }), ["media"]);
  assert.deepEqual(defaultScopes({ modules: [] }), ["global"]);
});

test("preselection: every requester holding a copy, in requester order", () => {
  assert.deepEqual(defaultScopes({ scope: "brain", modules: requesters("core", "builtin", "brain", "travel"), stored: stored("brain") }), ["brain"]);
  assert.deepEqual(defaultScopes({ scope: "media", modules: ha, stored: stored("media", "sonos") }), ["media", "sonos"]);
  // A requester copy wins over a global copy in the preselection, and global is not added to it.
  assert.deepEqual(defaultScopes({ scope: "global", modules: requesters("core", "builtin"), stored: stored("global", "builtin") }), ["builtin"]);
});

test("preselection: a global copy alone selects global; a leftover is never preselected", () => {
  assert.deepEqual(defaultScopes({ scope: "global", modules: ha, stored: stored("global") }), ["global"]);
  assert.deepEqual(defaultScopes({ scope: "global", modules: [], stored: stored("global") }), ["global"]);
  assert.deepEqual(defaultScopes({ modules: requesters("media"), stored: stored("gone") }), ["media"]);
  assert.deepEqual(defaultScopes({ modules: ha, stored: stored("gone") }), ["global"]);
});

test("toggling: global and the requesters exclude each other, order follows the options", () => {
  const options = ["media", "sonos", "global"];
  assert.deepEqual(toggleScope(options, ["media"], "sonos"), ["media", "sonos"]);
  assert.deepEqual(toggleScope(options, ["sonos"], "media"), ["media", "sonos"]);
  assert.deepEqual(toggleScope(options, ["media", "sonos"], "global"), ["global"]);
  assert.deepEqual(toggleScope(options, ["global"], "media"), ["media"]);
  assert.deepEqual(toggleScope(options, ["media", "sonos"], "media"), ["sonos"]);
  assert.deepEqual(toggleScope(options, ["global"], "global"), []);
});

test("save plan: a typed value goes to every selected scope", () => {
  assert.deepEqual(savePlan({ modules: ha }, ["media", "sonos"], "tok"), { writes: [{ scope: "media", value: "tok" }, { scope: "sonos", value: "tok" }] });
  // Rotating a shared token overwrites both copies.
  assert.deepEqual(savePlan({ scope: "media", modules: ha, stored: stored("media", "sonos") }, ["media", "sonos"], "new"), { writes: [{ scope: "media", value: "new" }, { scope: "sonos", value: "new" }] });
  // A deselected copy is left alone.
  assert.deepEqual(savePlan({ scope: "media", modules: ha, stored: stored("media", "sonos") }, ["sonos"], "x"), { writes: [{ scope: "sonos", value: "x" }] });
  // Adding a new value: no entry yet.
  assert.deepEqual(savePlan(null, ["global"], "v"), { writes: [{ scope: "global", value: "v" }] });
});

test("save plan: an empty value copies the stored value into the selected scopes without one", () => {
  assert.deepEqual(savePlan({ scope: "media", modules: ha, stored: stored("media") }, ["media", "sonos"], ""), { writes: [{ scope: "sonos", from: "media" }], source: "media" });
});

test("save plan: the copy source falls back to the entry's scope, then the first stored scope", () => {
  // No selected scope holds a copy: the entry's scope.
  assert.deepEqual(savePlan({ scope: "media", modules: requesters("media", "sonos", "brain"), stored: stored("global", "media") }, ["sonos"], ""), { writes: [{ scope: "sonos", from: "media" }], source: "media" });
  // No entry scope (e.g. an unreadable secret): the first stored scope.
  assert.deepEqual(savePlan({ modules: ha, stored: stored("gone", "media") }, ["sonos"], ""), { writes: [{ scope: "sonos", from: "gone" }], source: "gone" });
  // The first selected holder wins over the entry's scope.
  assert.deepEqual(savePlan({ scope: "global", modules: requesters("media", "sonos", "brain"), stored: stored("global", "sonos") }, ["sonos", "brain"], ""), { writes: [{ scope: "brain", from: "sonos" }], source: "sonos" });
});

test("save plan: nothing to save", () => {
  assert.equal(savePlan({ modules: ha }, ["media"], ""), null, "empty value and nothing stored");
  assert.equal(savePlan({ scope: "media", modules: ha, stored: stored("media", "sonos") }, ["media", "sonos"], ""), null, "every selected scope has a copy");
  assert.equal(savePlan({ modules: ha }, [], "tok"), null, "no scope selected");
  assert.equal(savePlan(null, ["global"], ""), null);
});
