import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";

const quiet = { log() {}, warn() {}, error() {} };

test("reload turns a failed module into loaded once its config exists, and disposes on subsequent reloads", async () => {
  const store = new Map<string, string>();
  let inits = 0, disposes = 0;
  const m = defineModule({
    manifest: { id: "m", label: "M", config: [{ key: "K", required: true }] },
    init(ctx) { inits++; ctx.defineTool({ name: "t", description: "", handler: () => ({ k: ctx.config.get("K") }) }); ctx.http.route("GET", "x", (_q, res) => res.json({})); },
    dispose() { disposes++; },
  });
  const r = new ToolRegistry(quiet);
  const h = new ModuleHost(r, { env: {}, log: quiet, resolve: () => (key) => store.get(key) });
  await h.load([m]);
  assert.equal(h.loaded()[0].status, "failed");
  store.set("K", "v1");
  const e = await h.reload("m");
  assert.equal(e?.status, "loaded");
  assert.deepEqual(e?.tools, ["t"]);
  assert.equal(h.routesOf("m")!.list().length, 1);
  assert.deepEqual((await r.callTool("t", {})).result, { k: "v1" });
  store.set("K", "v2");
  assert.deepEqual((await r.callTool("t", {})).result, { k: "v2" }, "config reads are live without reload");
  await h.reload("m");
  assert.equal(inits, 2);
  assert.equal(disposes, 1);
  assert.deepEqual(r.names(), ["t"], "no duplicate tools after reload");
});

test("reload failure leaves the module failed with the error; disabled and unknown ids are not reloadable", async () => {
  let fail = false;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { ctx.defineTool({ name: "t", description: "", handler: () => ({}) }); if (fail) throw new Error("later"); } });
  const d = defineModule({ manifest: { id: "d", label: "D" }, init() {} });
  const r = new ToolRegistry(quiet);
  const h = new ModuleHost(r, { env: {}, log: quiet, enabled: "m" });
  await h.load([m, d]);
  fail = true;
  const e = await h.reload("m");
  assert.equal(e?.status, "failed");
  assert.equal(e?.error, "later");
  assert.deepEqual(r.names(), []);
  assert.equal(await h.reload("d"), undefined);
  assert.equal(await h.reload("nope"), undefined);
});
