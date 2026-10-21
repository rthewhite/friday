import { test } from "node:test";
import assert from "node:assert/strict";
import { modules } from "../src/modules.js";

test("core ships the calendar, spotify and sonos modules alongside the others", () => {
  assert.deepEqual(modules.map((m) => m.manifest.id), ["builtin", "media", "brain", "travel", "spotify", "calendar", "sonos"]);
});
