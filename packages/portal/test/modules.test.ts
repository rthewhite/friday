import { test } from "node:test";
import assert from "node:assert/strict";
import { isReloadable, moduleKind, moduleTone } from "../src/lib/modules.ts";

const row = (id: string, status: "loaded" | "failed" | "disabled" | "connected") => ({ id, status });

test("core's entry is built in and never reloadable", () => {
  assert.equal(moduleKind(row("core", "loaded")), "built in");
  assert.equal(isReloadable(row("core", "loaded")), false);
});

test("in-process modules reload when loaded or failed, not when disabled", () => {
  assert.equal(moduleKind(row("media", "failed")), "in-process");
  assert.equal(isReloadable(row("builtin", "loaded")), true);
  assert.equal(isReloadable(row("media", "failed")), true);
  assert.equal(isReloadable(row("media", "disabled")), false);
});

test("MCP servers and remote modules are named as such and don't reload", () => {
  assert.equal(moduleKind(row("mcp:HomeAssistant", "loaded")), "MCP server");
  assert.equal(isReloadable(row("mcp:HomeAssistant", "failed")), false);
  assert.equal(moduleKind(row("simracing", "connected")), "remote");
  assert.equal(isReloadable(row("simracing", "connected")), false);
});

test("status dots: loaded and connected are green, failed red, disabled neutral", () => {
  assert.deepEqual(["loaded", "connected", "failed", "disabled"].map((s) => moduleTone(s as never)), ["success", "success", "error", "neutral"]);
});
