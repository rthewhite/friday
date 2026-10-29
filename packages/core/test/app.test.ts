import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { CORE_ID } from "../src/core-config.js";
import { MemoryModuleEnablement } from "../src/storage/module-enablement.js";

const quiet = { log() {}, warn() {}, error() {} };

async function start(disabled: string[] = [], coreTools: string[] = []) {
  const registry = new ToolRegistry(quiet);
  // Tools core registers itself, as server.ts does for the timer tools.
  for (const name of coreTools) registry.add(CORE_ID, { name, description: "", channels: ["voice"], handler: () => ({}) });
  const host = new ModuleHost(registry, { env: {}, log: quiet, enablement: new MemoryModuleEnablement(disabled) });
  const builtin = defineModule({ manifest: { id: "builtin", label: "Builtin" }, init: (ctx) => void ctx.defineTool({ name: "get_current_time", description: "", handler: () => ({}) }) });
  const media = defineModule({
    manifest: { id: "media", label: "Media", ui: true, config: [{ key: "JELLYFIN_URL", required: true }] },
    init(ctx) {
      ctx.http.route("GET", "search", (req, res) => res.json({ q: req.query.get("q") }));
      ctx.http.route("GET", "items/:id", (_req, res, params) => res.json({ id: params.id }));
      ctx.http.route("POST", "play", async (req, res) => { const b = await req.json<{ item: string }>(); res.status(202).json({ playing: b.item }); });
      ctx.http.route("GET", "boom", () => { throw new Error("nope"); });
      ctx.http.route("GET", "silent", () => {});
    },
  });
  await host.load([builtin, media]);
  const mcp = new McpSource(registry, undefined, { log: quiet });
  const webDir = await mkdtemp(join(tmpdir(), "friday-web-"));
  await writeFile(join(webDir, "index.html"), "<h1>hi</h1>");
  await mkdir(join(webDir, "assets"));
  await writeFile(join(webDir, "assets", "app-abc123.js"), "1;");
  const server = createServer(createApp({ registry, host, mcp, webDir }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, close: async () => { server.close(); await once(server, "close"); } };
}

test("/api/modules reports loaded and failed modules with tools and ui flag", async () => {
  const s = await start();
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.deepEqual(mods, [
      { id: "builtin", label: "Builtin", status: "loaded", tools: ["get_current_time"], ui: false },
      { id: "media", label: "Media", status: "failed", error: "module media: missing required config JELLYFIN_URL", tools: [], ui: true },
    ]);
    assert.deepEqual((await (await fetch(`${s.base}/api/tools`)).json()).map((t: { name: string }) => t.name), ["get_current_time"]);
    assert.deepEqual(await (await fetch(`${s.base}/health`)).json(), { ok: true, tools: 1 });
    // failed module: its routes are gone
    assert.equal((await fetch(`${s.base}/api/modules/media/search`)).status, 404);
  } finally {
    await s.close();
  }
});

test("core's own tools come first, as a built-in core entry, followed by the modules unchanged", async () => {
  const timers = ["set_timer", "set_alarm", "list_alerts", "change_alert", "cancel_alert", "snooze_alert"];
  const s = await start([], timers);
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.deepEqual(mods[0], { id: "core", label: "Core", description: "Built into Friday", status: "loaded", tools: timers, ui: false });
    assert.deepEqual(mods.slice(1).map((m: { id: string }) => m.id), ["builtin", "media"]);
    assert.deepEqual(mods[1].tools, ["get_current_time"], "a module's tools don't include core's");
  } finally {
    await s.close();
  }
});

test("without tools owned by core there is no core entry", async () => {
  const s = await start();
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.equal(mods.some((m: { id: string }) => m.id === "core"), false);
  } finally {
    await s.close();
  }
});

test("a disabled module is listed as disabled with no tools", async () => {
  const s = await start(["media"]);
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.deepEqual(mods[1], { id: "media", label: "Media", status: "disabled", tools: [], ui: true });
  } finally {
    await s.close();
  }
});

test("PUT enabled: disable drops the tools, enable loads them, a failed enable reports the error", async () => {
  const s = await start(["media"]);
  const put = (id: string, body: unknown) => fetch(`${s.base}/api/modules/${encodeURIComponent(id)}/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const tools = async () => ((await (await fetch(`${s.base}/api/tools`)).json()) as { name: string }[]).map((t) => t.name);
  try {
    assert.ok((await tools()).includes("get_current_time"));
    const off = await put("builtin", { enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { id: "builtin", label: "Builtin", status: "disabled", tools: [], ui: false });
    assert.equal((await tools()).includes("get_current_time"), false);

    const on = await put("builtin", { enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { id: "builtin", label: "Builtin", status: "loaded", tools: ["get_current_time"], ui: false });

    const failed = await put("media", { enabled: true });
    assert.equal(failed.status, 200);
    const entry = await failed.json();
    assert.equal(entry.status, "failed");
    assert.match(entry.error, /JELLYFIN_URL/);
  } finally {
    await s.close();
  }
});

test("PUT enabled: a body that is not a boolean is 400 and changes nothing; other kinds and unknown ids are 404", async () => {
  const s = await start();
  const put = (id: string, body: string) => fetch(`${s.base}/api/modules/${encodeURIComponent(id)}/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body });
  try {
    assert.equal((await put("builtin", JSON.stringify({ enabled: "no" }))).status, 400);
    assert.equal((await put("builtin", "{")).status, 400);
    assert.equal((await put("builtin", "{}")).status, 400);
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.equal(mods.find((m: { id: string }) => m.id === "builtin").status, "loaded");
    for (const id of ["core", "mcp:home", "nope"]) assert.equal((await put(id, JSON.stringify({ enabled: false }))).status, 404, id);
  } finally {
    await s.close();
  }
});

test("reloading a disabled module is 409 and it stays disabled", async () => {
  const s = await start(["media"]);
  try {
    const res = await fetch(`${s.base}/api/modules/media/reload`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /disabled/);
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.equal(mods.find((m: { id: string }) => m.id === "media").status, "disabled");
    assert.equal((await fetch(`${s.base}/api/modules/nope/reload`, { method: "POST" })).status, 404);
  } finally {
    await s.close();
  }
});

test("module routes: dispatch, params, JSON body, status, 404 for unknown module, 405, 500, 204", async () => {
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: { JELLYFIN_URL: "http://jf" }, log: quiet });
  const media = defineModule({
    manifest: { id: "media", label: "Media", config: [{ key: "JELLYFIN_URL", required: true }] },
    init(ctx) {
      ctx.http.route("GET", "search", (req, res) => res.json({ q: req.query.get("q") }));
      ctx.http.route("GET", "items/:id", (_req, res, params) => res.json({ id: params.id }));
      ctx.http.route("POST", "play", async (req, res) => { const b = await req.json<{ item: string }>(); res.status(202).json({ playing: b.item }); });
      ctx.http.route("GET", "boom", () => { throw new Error("nope"); });
      ctx.http.route("GET", "silent", () => {});
    },
  });
  await host.load([media]);
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, undefined, { log: quiet }), webDir: "/nonexistent" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const origError = console.error; console.error = () => {};
  try {
    assert.deepEqual(await (await fetch(`${base}/api/modules/media/search?q=x`)).json(), { q: "x" });
    assert.deepEqual(await (await fetch(`${base}/api/modules/media/items/42`)).json(), { id: "42" });
    const play = await fetch(`${base}/api/modules/media/play`, { method: "POST", body: JSON.stringify({ item: "ep1" }), headers: { "content-type": "application/json" } });
    assert.equal(play.status, 202);
    assert.deepEqual(await play.json(), { playing: "ep1" });
    assert.equal((await fetch(`${base}/api/modules/nope/search`)).status, 404);
    assert.equal((await fetch(`${base}/api/modules/media/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/modules/media/search`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${base}/api/modules/media/boom`)).status, 500);
    assert.equal((await fetch(`${base}/api/modules/media/silent`)).status, 204);
  } finally {
    console.error = origError;
    server.close();
    await once(server, "close");
  }
});

test("static: root, hashed asset caching, SPA fallback, reserved paths 404, traversal 400", async () => {
  const s = await start();
  try {
    const root = await fetch(`${s.base}/`);
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(root.headers.get("cache-control"), "no-cache");
    assert.equal(await root.text(), "<h1>hi</h1>");
    const js = await fetch(`${s.base}/assets/app-abc123.js`);
    assert.equal(js.headers.get("content-type"), "text/javascript");
    assert.match(js.headers.get("cache-control")!, /immutable/);
    const spa = await fetch(`${s.base}/m/media`);
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), "<h1>hi</h1>");
    assert.equal((await fetch(`${s.base}/nope.css`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/ws/other`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2F..%2Fetc%2Fpasswd`)).status, 400);
    assert.equal((await fetch(`${s.base}/m/media`, { method: "POST" })).status, 405);
  } finally {
    await s.close();
  }
});
