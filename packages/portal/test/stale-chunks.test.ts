import { test } from "node:test";
import assert from "node:assert/strict";
import { isChunkLoadError, RELOAD_GUARD_MS, shouldReload } from "../src/lib/stale-chunks.ts";

test("failed dynamic imports are recognised in every browser's wording", () => {
  assert.ok(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://friday.thewhite.nl/assets/ChatPage-BV3rT8Xw.js")));
  assert.ok(isChunkLoadError(new TypeError("Importing a module script failed.")));
  assert.ok(isChunkLoadError(new TypeError("error loading dynamically imported module: https://friday.thewhite.nl/assets/ChatPage-BV3rT8Xw.js")));
  const chunk = new Error("Loading chunk 12 failed");
  chunk.name = "ChunkLoadError";
  assert.ok(isChunkLoadError(chunk));
});

test("other errors are not chunk load errors", () => {
  assert.equal(isChunkLoadError(new Error("navigation guard said no")), false);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
  assert.equal(isChunkLoadError("Importing a module script failed"), false, "only Error objects");
  assert.equal(isChunkLoadError(undefined), false);
});

test("a reload is allowed once per guard window", () => {
  const now = 1_000_000;
  assert.equal(shouldReload(now, null), true, "no previous reload");
  assert.equal(shouldReload(now, String(now - 9_000)), false, "9 s after one");
  assert.equal(shouldReload(now, String(now - RELOAD_GUARD_MS)), true, "10 s after one");
  assert.equal(shouldReload(now, "garbage"), true, "an unreadable value does not block");
});
