import { test } from "node:test";
import assert from "node:assert/strict";
import { modules } from "../src/modules.js";

test("core ships the calendar module alongside the others", () => {
  assert.deepEqual(modules.map((m) => m.manifest.id), ["builtin", "media", "brain", "travel", "calendar"]);
});
