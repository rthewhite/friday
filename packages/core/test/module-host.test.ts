import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, ToolRegistry, type ModuleLogger } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";

function logger() {
  const lines: string[] = [];
  const log: ModuleLogger = {
    log: (...a) => lines.push("log " + a.join(" ")),
    warn: (...a) => lines.push("warn " + a.join(" ")),
    error: (...a) => lines.push("error " + a.join(" ")),
  };
  return { lines, log };
}

const order: string[] = [];
const a = defineModule({
  manifest: { id: "a", label: "A" },
  init(ctx) { ctx.defineTool({ name: "a1", description: "", handler: () => ({}) }); },
  dispose: () => void order.push("a"),
});
const b = defineModule({
  manifest: { id: "b", label: "B", description: "bee", config: [{ key: "B_KEY", required: true }] },
  init(ctx) { ctx.defineTool({ name: "b1", description: "", handler: () => ({}) }); },
  dispose: () => void order.push("b"),
});
const boom = defineModule({
  manifest: { id: "boom", label: "Boom" },
  init(ctx) {
    ctx.defineTool({ name: "half", description: "", handler: () => ({}) });
    throw new Error("kaboom");
  },
});

test("default: every module loads in order and is logged with its tools", async () => {
  const { lines, log } = logger();
  const r = new ToolRegistry(log);
  const h = new ModuleHost(r, { env: { B_KEY: "x" }, log });
  await h.load([a, b]);
  assert.deepEqual(r.names(), ["a1", "b1"]);
  assert.deepEqual(h.loaded(), [
    { id: "a", label: "A", description: undefined, status: "loaded", tools: ["a1"], ui: false },
    { id: "b", label: "B", description: "bee", status: "loaded", tools: ["b1"], ui: false },
  ]);
  assert.deepEqual(lines, ["log module a: a1", "log module b: b1"]);
});

test("FRIDAY_MODULES subset disables others and warns about unknown ids", async () => {
  const { lines, log } = logger();
  const r = new ToolRegistry(log);
  const h = new ModuleHost(r, { env: {}, log, enabled: "a, nope" });
  await h.load([a, b]);
  assert.deepEqual(r.names(), ["a1"]);
  assert.equal(h.loaded()[1].status, "disabled");
  assert.deepEqual(h.loaded()[1].tools, []);
  assert.ok(lines.some((l) => l.startsWith("warn") && l.includes('"nope"')));
});

test("missing required config fails only that module", async () => {
  const { lines, log } = logger();
  const r = new ToolRegistry(log);
  const h = new ModuleHost(r, { env: {}, log });
  await h.load([b, a]);
  const [eb, ea] = h.loaded();
  assert.equal(eb.status, "failed");
  assert.match(eb.error!, /module b: missing required config B_KEY/);
  assert.equal(ea.status, "loaded");
  assert.ok(lines.some((l) => l.startsWith("error module b failed")));
});

test("init throwing rolls back the tools it registered", async () => {
  const { log } = logger();
  const r = new ToolRegistry(log);
  const h = new ModuleHost(r, { env: {}, log });
  await h.load([boom, a]);
  assert.deepEqual(r.names(), ["a1"]);
  assert.equal(h.loaded()[0].status, "failed");
  assert.equal(h.loaded()[0].error, "kaboom");
});

test("dispose runs in reverse order and skips modules that did not load", async () => {
  order.length = 0;
  const { log } = logger();
  const h = new ModuleHost(new ToolRegistry(log), { env: { B_KEY: "1" }, log });
  await h.load([a, b, boom]);
  await h.dispose();
  assert.deepEqual(order, ["b", "a"]);
});

test("context logger is prefixed with the module id", async () => {
  const { lines, log } = logger();
  const m = defineModule({ manifest: { id: "media", label: "M" }, init: (ctx) => ctx.log.warn("slow") });
  await new ModuleHost(new ToolRegistry(log), { env: {}, log }).load([m]);
  assert.ok(lines.includes("warn [media] slow"));
});

test("routes are registered per module and cleared when init fails or on dispose", async () => {
  const { log } = logger();
  const r = new ToolRegistry(log);
  const h = new ModuleHost(r, { env: {}, log });
  const ok = defineModule({ manifest: { id: "ok", label: "Ok" }, init: (ctx) => ctx.http.route("GET", "ping", (_q, res) => res.json({ pong: true })) });
  const bad = defineModule({ manifest: { id: "bad", label: "Bad" }, init(ctx) { ctx.http.route("GET", "x", () => {}); throw new Error("no"); } });
  await h.load([ok, bad]);
  assert.equal(h.routesOf("ok")!.list().length, 1);
  assert.equal(h.routesOf("bad"), undefined);
  await h.dispose();
  assert.equal(h.routesOf("ok")!.list().length, 0);
});
