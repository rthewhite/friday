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

const quiet = { log() {}, warn() {}, error() {} };

async function start(enabled?: string) {
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet, enabled });
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

test("FRIDAY_MODULES=builtin shows media as disabled with no tools", async () => {
  const s = await start("builtin");
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.deepEqual(mods[1], { id: "media", label: "Media", status: "disabled", tools: [], ui: true });
  } finally {
    await s.close();
  }
});

test("module routes: dispatch, params, JSON body, status, 404 for unknown module, 405, 500, 204", async () => {
  process.env.JELLYFIN_URL = "x";
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
