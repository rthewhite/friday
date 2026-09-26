import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  const media = defineModule({ manifest: { id: "media", label: "Media", config: [{ key: "JELLYFIN_URL", required: true }] }, init() {} });
  await host.load([builtin, media]);
  const mcp = new McpSource(registry, quiet);
  const webDir = await mkdtemp(join(tmpdir(), "friday-web-"));
  await writeFile(join(webDir, "index.html"), "<h1>hi</h1>");
  await writeFile(join(webDir, "app.js"), "1;");
  const server = createServer(createApp({ registry, host, mcp, webDir }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, close: async () => { server.close(); await once(server, "close"); } };
}

test("/api/modules reports loaded and failed modules with tools", async () => {
  const s = await start();
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.deepEqual(mods, [
      { id: "builtin", label: "Builtin", status: "loaded", tools: ["get_current_time"] },
      { id: "media", label: "Media", status: "failed", error: "module media: missing required config JELLYFIN_URL", tools: [] },
    ]);
    const tools = await (await fetch(`${s.base}/api/tools`)).json();
    assert.deepEqual(tools.map((t: { name: string }) => t.name), ["get_current_time"]);
    const health = await (await fetch(`${s.base}/health`)).json();
    assert.deepEqual(health, { ok: true, tools: 1 });
  } finally {
    await s.close();
  }
});

test("FRIDAY_MODULES=builtin shows media as disabled with no tools", async () => {
  const s = await start("builtin");
  try {
    const mods = await (await fetch(`${s.base}/api/modules`)).json();
    assert.deepEqual(mods[1], { id: "media", label: "Media", status: "disabled", tools: [] });
  } finally {
    await s.close();
  }
});

test("static files: root, asset, 404, traversal", async () => {
  const s = await start();
  try {
    const root = await fetch(`${s.base}/`);
    assert.equal(root.headers.get("content-type"), "text/html");
    assert.equal(await root.text(), "<h1>hi</h1>");
    const js = await fetch(`${s.base}/app.js`);
    assert.equal(js.headers.get("content-type"), "text/javascript");
    assert.equal((await fetch(`${s.base}/nope.css`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2F..%2Fetc%2Fpasswd`)).status, 400);
  } finally {
    await s.close();
  }
});
