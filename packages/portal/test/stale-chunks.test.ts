import { test } from "node:test";
import assert from "node:assert/strict";
import { clearReloadMark, handleNavigationError, isChunkLoadError, RELOAD_KEY, type ReloadEnv } from "../src/lib/stale-chunks.ts";

const chrome = () => new TypeError("Failed to fetch dynamically imported module: https://friday.thewhite.nl/assets/ChatPage-BV3rT8Xw.js");

test("failed page imports are recognised in every browser's wording, and Vite's missing CSS", () => {
  assert.ok(isChunkLoadError(chrome()));
  assert.ok(isChunkLoadError(new TypeError("Importing a module script failed.")));
  assert.ok(isChunkLoadError(new TypeError("error loading dynamically imported module: https://friday.thewhite.nl/assets/ChatPage-BV3rT8Xw.js")));
  assert.ok(isChunkLoadError(new Error("Unable to preload CSS for /assets/PageView-Cx1b2f3D.css")));
});

test("other errors are not chunk load errors", () => {
  assert.equal(isChunkLoadError(new Error("navigation guard said no")), false);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
  assert.equal(isChunkLoadError("Importing a module script failed"), false, "only Error objects");
  assert.equal(isChunkLoadError(undefined), false);
});

/** A fake tab at `href`. */
function tab(href: string, opts: { blocked?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const logged: unknown[] = [];
  const guard = () => { if (opts.blocked) throw new DOMException("The operation is insecure.", "SecurityError"); };
  const env: ReloadEnv = {
    storage: {
      getItem: (k) => { guard(); return store.get(k) ?? null; },
      setItem: (k, v) => { guard(); store.set(k, v); },
      removeItem: (k) => { guard(); store.delete(k); },
    },
    location: { href, assign: (url) => void calls.push(`assign ${url}`), reload: () => void calls.push("reload") },
    history: { replaceState: (_d, _u, url) => void calls.push(`replaceState ${url}`) },
    log: (e) => void logged.push(e),
  };
  return { env, store, calls, logged };
}

test("a stale tab navigating to another page reloads there once and marks the target", () => {
  const t = tab("https://friday.thewhite.nl/");
  assert.equal(handleNavigationError(chrome(), "/chat", t.env), "reloaded");
  assert.deepEqual(t.calls, ["assign https://friday.thewhite.nl/chat"]);
  assert.equal(t.store.get(RELOAD_KEY), "/chat");
  assert.deepEqual(t.logged, []);
});

test("after the reload, the same page failing again is logged and not reloaded", () => {
  const t = tab("https://friday.thewhite.nl/chat");
  t.store.set(RELOAD_KEY, "/chat");
  const error = chrome();
  assert.equal(handleNavigationError(error, "/chat", t.env), "logged");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.logged, [error]);
});

test("a successful navigation clears the mark, so a later deploy can reload the same page again", () => {
  const t = tab("https://friday.thewhite.nl/");
  t.store.set(RELOAD_KEY, "/chat");
  clearReloadMark(t.env.storage);
  assert.equal(handleNavigationError(chrome(), "/chat", t.env), "reloaded");
});

test("the initial load failing at the current URL reloads the document, also when only the hash differs", () => {
  const same = tab("https://friday.thewhite.nl/m/brain/p/x");
  assert.equal(handleNavigationError(chrome(), "/m/brain/p/x", same.env), "reloaded");
  assert.deepEqual(same.calls, ["reload"]);
  const hash = tab("https://friday.thewhite.nl/m/brain/p/x");
  assert.equal(handleNavigationError(chrome(), "/m/brain/p/x#section", hash.env), "reloaded");
  assert.deepEqual(hash.calls, ["replaceState https://friday.thewhite.nl/m/brain/p/x#section", "reload"], "assign would only scroll");
});

test("other errors are logged, never reloaded", () => {
  const t = tab("https://friday.thewhite.nl/");
  const error = new Error("navigation guard said no");
  assert.equal(handleNavigationError(error, "/chat", t.env), "logged");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.logged, [error]);
  assert.equal(t.store.has(RELOAD_KEY), false);
});

test("blocked storage logs the original error instead of reloading without a loop guard", () => {
  const t = tab("https://friday.thewhite.nl/", { blocked: true });
  const error = chrome();
  assert.equal(handleNavigationError(error, "/chat", t.env), "logged");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.logged, [error]);
  assert.doesNotThrow(() => clearReloadMark(t.env.storage));
});
