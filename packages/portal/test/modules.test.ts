import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPage, isReloadable, isSwitchedOn, isToggleable, moduleKind, moduleTone, withEntry } from "../src/lib/modules.ts";

const row = (id: string, status: "loaded" | "failed" | "disabled" | "connected") => ({ id, status });

test("core's entry has kind core and is never reloadable", () => {
  assert.equal(moduleKind(row("core", "loaded")), "core");
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

test("only a loaded module with a UI has a page: /m/core shows the gate, not a blank page", () => {
  assert.equal(hasPage({ status: "loaded", ui: true }), true);
  assert.equal(hasPage({ status: "loaded", ui: false }), false, "core's entry");
  assert.equal(hasPage({ status: "failed", ui: true }), false);
  assert.equal(hasPage({ status: "connected" }), false, "remotes have no UI");
});

test("status dots: loaded and connected are green, failed red, disabled neutral", () => {
  assert.deepEqual(["loaded", "connected", "failed", "disabled"].map((s) => moduleTone(s as never)), ["success", "success", "error", "neutral"]);
});

test("only in-process modules have a switch, in every status; core, MCP servers and remotes don't", () => {
  for (const status of ["loaded", "failed", "disabled"] as const) assert.equal(isToggleable(row("sonos", status)), true, status);
  assert.equal(isToggleable(row("core", "loaded")), false);
  assert.equal(isToggleable(row("mcp:home", "loaded")), false);
  assert.equal(isToggleable(row("simracing", "connected")), false);
  assert.deepEqual(["loaded", "failed", "disabled"].map((s) => isSwitchedOn({ status: s as never })), [true, true, false]);
});

test("a disabled module can't be reloaded", () => {
  assert.equal(isReloadable(row("sonos", "disabled")), false);
});

test("the server's new entry replaces the old one, and a disabled module loses its page", () => {
  const list = [
    { id: "builtin", label: "Builtin", status: "loaded" as const, tools: ["t"], ui: false },
    { id: "sonos", label: "Sonos", status: "loaded" as const, tools: ["sonos_play"], ui: true },
  ];
  const next = withEntry(list, { id: "sonos", label: "Sonos", status: "disabled", tools: [], ui: true });
  assert.equal(next[0], list[0], "other entries are kept as they are");
  assert.deepEqual(next[1], { id: "sonos", label: "Sonos", status: "disabled", tools: [], ui: true });
  assert.equal(hasPage(next[1]), false);
  assert.equal(list[1].status, "loaded", "the old list is not changed");
});
