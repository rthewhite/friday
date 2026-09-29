import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, migrate, migrations, openDatabase } from "../src/storage/db.js";
import { createPromptContext } from "../src/prompt-context.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";
import { setup } from "./conversation-fixtures.js";

const quiet = { log() {}, warn() {}, error() {} };

test("after a reload the old onQuiet handler no longer fires and the new one does; a failed init leaves none", async () => {
  const { store } = setup();
  const fired: number[] = [];
  let generation = 0, fail = false;
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      const g = ++generation;
      ctx.conversations.onQuiet(() => void fired.push(g));
      if (fail) throw new Error("broken");
    },
  });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, conversations: (id) => store.forOwner(id) });
  await h.load([m]);
  const quietOne = async () => {
    const id = store.create({ channel: "chat" });
    store.markQuiet(id);
    await new Promise((r) => setImmediate(r));
  };
  await quietOne();
  assert.deepEqual(fired, [1]);
  await h.reload("brain");
  await quietOne();
  assert.deepEqual(fired, [1, 2]);
  fail = true;
  assert.equal((await h.reload("brain"))?.status, "failed");
  await quietOne();
  assert.deepEqual(fired, [1, 2], "neither the disposed nor the failed init's handler fires");
  fail = false;
  await h.reload("brain");
  await h.dispose();
  await quietOne();
  assert.deepEqual(fired, [1, 2]);
});

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

test("reload stops the old job, cancels its run, keeps history and causes no spurious catch-up", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = new FakeClock(Date.parse("2026-09-28T12:00:00Z"));
  const store = new JobStore(db);
  const s = new Scheduler({ store, clock, log: quiet, catchupDelayMs: 1000, graceMs: 1000 });
  const runs: string[] = [];
  const m = defineModule({
    manifest: { id: "m", label: "M" },
    init(ctx) {
      ctx.jobs.schedule({ name: "tick", everyMs: 60_000, run: async ({ trigger, signal }) => { runs.push(trigger); await clock.sleep(10_000, signal); } });
    },
  });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, jobs: (id) => s.forOwner(id) });
  await h.load([m]);
  await clock.advance(65_000); // scheduled run at +60 s is in progress
  assert.equal(s.list()[0].running, true);
  await h.reload("m");
  assert.deepEqual(store.runs("m/tick").map((r) => [r.trigger, r.outcome]), [["schedule", "cancelled"]], "history kept, running run cancelled");
  assert.equal(s.list()[0].nextRunAt, "2026-09-28T12:02:00.000Z", "schedule continues from the last due time");
  await clock.advance(5000);
  assert.deepEqual(runs, ["schedule"], "no catch-up after reload");
  await clock.advance(50_000);
  assert.deepEqual(runs, ["schedule", "schedule"]);
  assert.equal(store.runs("m/tick").length, 2);
  await h.dispose();
});

function dataDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "friday-reload-"));
  const core = openDatabase(dir, "friday.db", { log() {} });
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { database: databasePath(dir), core };
}

test("reload runs only migrations that became pending, and none when nothing changed", async (t) => {
  const { database, core } = dataDir(t);
  const applied: string[] = [];
  const log = { log: (...a: unknown[]) => void applied.push(a.join(" ")), warn() {}, error() {} };
  let inits = 0;
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    migrations: [{ version: 1, name: "pages", up: "CREATE TABLE brain__pages (id INTEGER PRIMARY KEY)" }],
    init() { inits++; },
  });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log, database });
  await h.load([m]);
  await h.reload("brain");
  // The module's code changed: a new migration is declared.
  m.migrations!.push({ version: 2, name: "revisions", up: "CREATE TABLE brain__revisions (id INTEGER PRIMARY KEY)" });
  assert.equal((await h.reload("brain"))?.status, "loaded");
  assert.deepEqual(applied.filter((l) => l.includes("migration")), ['[brain] migration 1 "pages" applied', '[brain] migration 2 "revisions" applied']);
  assert.equal(inits, 3);
  assert.equal(core.prepare("SELECT version FROM module_schema WHERE module_id = 'brain'").get()?.version, 2);
  await h.dispose();
});

test("prompt context providers are replaced on reload, rendered in load order, and dropped on failure", async () => {
  const prompt = createPromptContext({ log: quiet });
  let fail = false, generation = 0;
  const brain = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      const g = ++generation;
      ctx.prompt.addContext(() => `brain v${g}`);
      if (fail) throw new Error("broken");
    },
  });
  const media = defineModule({ manifest: { id: "media", label: "Media" }, init(ctx) { ctx.prompt.addContext(() => "media"); } });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, prompt });
  await h.load([brain, media]);
  assert.equal(prompt.render("voice"), "brain v1\n\nmedia");
  await h.reload("brain");
  // Exactly one provider of brain, still ahead of media (load order survives the reload).
  assert.equal(prompt.render("voice"), "brain v2\n\nmedia");
  fail = true;
  assert.equal((await h.reload("brain"))?.status, "failed");
  assert.equal(prompt.render("chat"), "media");
  await h.dispose();
  assert.equal(prompt.render("chat"), "");
});

test("a module that throws in init after registering a provider is never called", async () => {
  const prompt = createPromptContext({ log: quiet });
  let calls = 0;
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.prompt.addContext(() => { calls++; return "never"; });
      throw new Error("broken");
    },
  });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, prompt });
  await h.load([m]);
  assert.equal(h.loaded()[0].status, "failed");
  assert.equal(prompt.render("voice"), "");
  assert.equal(calls, 0);
});
