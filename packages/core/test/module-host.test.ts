import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineModule, LlmError, ToolRegistry, type ModuleContext, type ModuleLogger } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";
import { DatabaseSync } from "node:sqlite";
import { databasePath, migrate, migrations, openDatabase } from "../src/storage/db.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";
import { LlmService } from "../src/llm/service.js";

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

function jobHost(log: ModuleLogger) {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, { log() {} });
  const clock = new FakeClock(Date.parse("2026-09-28T12:00:00Z"));
  const store = new JobStore(db);
  const scheduler = new Scheduler({ store, clock, log, catchupDelayMs: 1000, graceMs: 1000 });
  return { clock, store, scheduler, host: new ModuleHost(new ToolRegistry(log), { env: {}, log, jobs: (id) => scheduler.forOwner(id) }) };
}

test("a module whose init fails leaves no jobs; an invalid job fails the module with the job error", async () => {
  const { log } = logger();
  const { host, scheduler } = jobHost(log);
  const late = defineModule({ manifest: { id: "late", label: "Late" }, init(ctx) { ctx.jobs.schedule({ name: "tick", everyMs: 1000, run() {} }); throw new Error("no"); } });
  const invalid = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) { ctx.defineTool({ name: "recall", description: "", handler: () => ({}) }); ctx.jobs.schedule({ name: "nightly", cron: "61 * * * *", run() {} }); },
  });
  const reserved = defineModule({ manifest: { id: "core", label: "Core" }, init() {} });
  await host.load([late, invalid, reserved]);
  assert.deepEqual(scheduler.list(), []);
  const [l, b, c] = host.loaded();
  assert.equal(l.status, "failed");
  assert.equal(b.status, "failed");
  assert.match(b.error!, /job brain\/nightly: invalid cron "61 \* \* \* \*"/);
  assert.deepEqual(b.tools, []);
  assert.equal(c.status, "failed");
  assert.match(c.error!, /module id "core" is reserved/);
});

test("dispose cancels a running job before module.dispose runs", async () => {
  const { log } = logger();
  const { host, scheduler, store } = jobHost(log);
  const order: string[] = [];
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.jobs.schedule({ name: "nightly", cron: "0 3 * * *", run: ({ signal }) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => { order.push("aborted"); reject(signal.reason); })) });
    },
    dispose: () => void order.push("dispose"),
  });
  await host.load([m]);
  assert.equal(scheduler.runNow("brain/nightly").status, "started");
  await host.dispose();
  assert.deepEqual(order, ["aborted", "dispose"]);
  assert.equal(store.runs("brain/nightly")[0].outcome, "cancelled");
  assert.deepEqual(scheduler.list(), []);
});

test("ctx.llm calls are attributed to the module id; without a service they are unavailable", async () => {
  const { lines, log } = logger();
  const service = new LlmService({
    model: { generate: async (req) => ({ text: `echo ${req.model}`, model: req.model, usage: { inputTokens: 3, outputTokens: 2, thoughtTokens: 0 } }) },
    models: { standard: "std", fast: "quick" },
    concurrency: 2,
    timeoutMs: 1000,
    log,
  });
  const results: unknown[] = [];
  const m = defineModule({ manifest: { id: "brain", label: "Brain" }, init: async (ctx) => void results.push((await ctx.llm.generate({ prompt: "hello" })).text) });
  await new ModuleHost(new ToolRegistry(log), { env: {}, log, llm: (id) => service.forOwner(id) }).load([m]);
  assert.deepEqual(results, ["echo std"]);
  assert.ok(lines.some((l) => /^log llm: \[brain\] std ok in=3 out=2 /.test(l)), lines.join("\n"));

  const bare = defineModule({ manifest: { id: "bare", label: "Bare" }, init: async (ctx) => void (await ctx.llm.generate({ prompt: "x" }).catch((e) => results.push(e instanceof LlmError && e.kind))) });
  await new ModuleHost(new ToolRegistry(log), { env: {}, log }).load([bare]);
  assert.deepEqual(results, ["echo std", "unavailable"]);
});

/** A data dir with core's friday.db (all core migrations applied), as the server opens it. */
function dataDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "friday-host-"));
  const core = openDatabase(dir, "friday.db", { log() {} });
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { database: databasePath(dir), core };
}

test("migrations run after the config check and before init, and init can query their tables", async (t) => {
  const { database, core } = dataDir(t);
  const { lines, log } = logger();
  const steps: string[] = [];
  let rows: unknown[] = [];
  const m = defineModule({
    manifest: { id: "hello", label: "Hello", config: [{ key: "HELLO_KEY", required: true }] },
    migrations: [
      { version: 1, name: "items", up: "CREATE TABLE hello__items (name TEXT NOT NULL); INSERT INTO hello__items VALUES ('first')" },
      { version: 2, name: "more", up: (db) => { steps.push("migration 2"); db.exec("INSERT INTO hello__items VALUES ('second')"); } },
    ],
    init(ctx) {
      steps.push("init");
      rows = ctx.db.prepare("SELECT name FROM hello__items ORDER BY rowid").all().map((r) => r.name);
    },
  });
  const unconfigured = new ModuleHost(new ToolRegistry(log), { env: {}, log, database });
  await unconfigured.load([m]);
  assert.equal(unconfigured.loaded()[0].status, "failed");
  assert.equal(core.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'hello__items'").get()?.n, 0);
  await unconfigured.dispose();

  const h = new ModuleHost(new ToolRegistry(log), { env: { HELLO_KEY: "x" }, log, database });
  await h.load([m]);
  assert.equal(h.loaded()[0].status, "loaded");
  assert.deepEqual(steps, ["migration 2", "init"]);
  assert.deepEqual(rows, ["first", "second"]);
  assert.deepEqual(lines.filter((l) => l.includes("migration")), ['log [hello] migration 1 "items" applied', 'log [hello] migration 2 "more" applied']);
  assert.equal(core.prepare("SELECT version FROM module_schema WHERE module_id = 'hello'").get()?.version, 2);
  await h.dispose();
});

test("a broken migration fails only its module, naming it, the version and the name", async (t) => {
  const { database, core } = dataDir(t);
  const { lines, log } = logger();
  let inits = 0;
  const brain = defineModule({
    manifest: { id: "brain", label: "Brain" },
    migrations: [
      { version: 1, name: "pages", up: "CREATE TABLE brain__pages (id INTEGER PRIMARY KEY)" },
      { version: 2, name: "revisions", up: "CREATE TABLE brain__revisions (id INTEGER PRIMARY KEY); CREAT TABLE nope (a)" },
    ],
    init(ctx) { inits++; ctx.defineTool({ name: "brain_tool", description: "", handler: () => ({}) }); },
  });
  const r = new ToolRegistry(log);
  const h = new ModuleHost(r, { env: {}, log, database });
  await h.load([brain, a]);
  const [b0, a0] = h.loaded();
  assert.equal(b0.status, "failed");
  assert.match(b0.error!, /^module brain: migration 2 "revisions" failed: .*syntax error/);
  assert.equal(a0.status, "loaded");
  assert.equal(inits, 0);
  assert.deepEqual(r.names(), ["a1"]);
  assert.equal(core.prepare("SELECT version FROM module_schema WHERE module_id = 'brain'").get()?.version, 1);
  assert.ok(lines.some((l) => l.startsWith('error module brain failed to load: module brain: migration 2 "revisions" failed')));
  await h.dispose();
});

test("a module's database is refused core's tables, and a schema newer than the module fails it", async (t) => {
  const { database, core } = dataDir(t);
  const { log } = logger();
  let refused = "";
  const nosy = defineModule({
    manifest: { id: "nosy", label: "Nosy" },
    init(ctx) {
      try { ctx.db.prepare("SELECT * FROM config_values"); } catch (e) { refused = (e as Error).message; }
    },
  });
  const v2 = defineModule({
    manifest: { id: "brain", label: "Brain" },
    migrations: [{ version: 1, name: "pages", up: "CREATE TABLE brain__pages (id INTEGER PRIMARY KEY)" }, { version: 2, name: "x", up: "SELECT 1" }],
    init() {},
  });
  const first = new ModuleHost(new ToolRegistry(log), { env: {}, log, database });
  await first.load([nosy, v2]);
  assert.match(refused, /^module nosy: database access refused: read config_values/);
  await first.dispose();
  const rolledBack = new ModuleHost(new ToolRegistry(log), { env: {}, log, database });
  await rolledBack.load([{ ...v2, migrations: v2.migrations!.slice(0, 1) }]);
  assert.deepEqual(rolledBack.loaded()[0].error, "database schema v2 is newer than module brain's migrations (v1)");
  assert.equal(core.prepare("SELECT version FROM module_schema WHERE module_id = 'brain'").get()?.version, 2);
  await rolledBack.dispose();
});

test("without a database a module that declares migrations fails and ctx.db is unavailable", async () => {
  const { log } = logger();
  let err = "";
  const withMigrations = defineModule({ manifest: { id: "m", label: "M" }, migrations: [{ version: 1, name: "x", up: "SELECT 1" }], init() {} });
  const plain = defineModule({ manifest: { id: "p", label: "P" }, init(ctx) { try { ctx.db.exec("SELECT 1"); } catch (e) { err = (e as Error).message; } } });
  const h = new ModuleHost(new ToolRegistry(log), { env: {}, log });
  await h.load([withMigrations, plain]);
  assert.equal(h.loaded()[0].error, "m: database is not available in this host");
  assert.equal(err, "p: database is not available in this host");
});

test("dispose closes the modules' connections, and they do not reopen", async (t) => {
  const { database } = dataDir(t);
  const { log } = logger();
  let db: ModuleContext["db"] | undefined;
  const m = defineModule({ manifest: { id: "m", label: "M" }, migrations: [{ version: 1, name: "t", up: "CREATE TABLE m__t (a)" }], init(ctx) { db = ctx.db; } });
  const h = new ModuleHost(new ToolRegistry(log), { env: {}, log, database });
  await h.load([m]);
  db!.exec("INSERT INTO m__t VALUES (1)");
  await h.dispose();
  assert.throws(() => db!.exec("INSERT INTO m__t VALUES (2)"), /m: database is closed/);
});
