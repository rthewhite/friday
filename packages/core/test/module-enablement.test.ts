import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";
import { databasePath, migrate, migrations, openDatabase } from "../src/storage/db.js";
import { MemoryModuleEnablement, SqliteModuleEnablement } from "../src/storage/module-enablement.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";

const quiet = { log() {}, warn() {}, error() {} };

function dataDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "friday-enable-"));
  const core = openDatabase(dir, "friday.db", { log() {} });
  t.after(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { database: databasePath(dir), core };
}

/** A module with one tool and one route that records its lifecycle. */
function speakers(events: string[]) {
  return defineModule({
    manifest: { id: "sonos", label: "Sonos" },
    init(ctx) {
      events.push("init");
      ctx.defineTool({ name: "sonos_play", description: "", handler: () => ({ ok: true }) });
      ctx.http.route("GET", "speakers", (_req, res) => res.json([]));
    },
    dispose: () => void events.push("dispose"),
  });
}

test("disabling a loaded module removes its tools and routes, disposes it, and stores the choice", async () => {
  const events: string[] = [];
  const registry = new ToolRegistry(quiet);
  const enablement = new MemoryModuleEnablement();
  const h = new ModuleHost(registry, { env: {}, log: quiet, enablement });
  await h.load([speakers(events)]);
  assert.ok(h.routesOf("sonos"));

  const entry = await h.setEnabled("sonos", false);
  assert.deepEqual(entry, { id: "sonos", label: "Sonos", description: undefined, status: "disabled", tools: [], ui: false });
  assert.deepEqual(registry.names(), []);
  assert.equal(h.routesOf("sonos"), undefined, "its routes answer 404");
  assert.deepEqual(events, ["init", "dispose"]);
  assert.equal(enablement.isEnabled("sonos"), false);
});

test("a voice session that was offered a tool gets an unknown-tool error after the disable", async () => {
  const registry = new ToolRegistry(quiet);
  const h = new ModuleHost(registry, { env: {}, log: quiet });
  await h.load([speakers([])]);
  const offered = registry.declarations("voice").map((d) => d.name);
  assert.ok(offered.includes("sonos_play"));

  await h.setEnabled("sonos", false);
  const call = await registry.callTool("sonos_play", {}, { channel: "voice" });
  assert.deepEqual(call.result, { error: "unknown tool sonos_play" });
  assert.equal(registry.declarations("voice").some((d) => d.name === "sonos_play"), false, "the next session is not offered it");
});

test("disabling a failed module only changes its status; enabling or disabling twice changes nothing", async () => {
  const events: string[] = [];
  const broken = defineModule({ manifest: { id: "media", label: "Media", config: [{ key: "JELLYFIN_URL", required: true }] }, init() { events.push("init"); }, dispose: () => void events.push("dispose") });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, enablement: new MemoryModuleEnablement() });
  await h.load([broken]);
  assert.equal(h.loaded()[0].status, "failed");

  const off = await h.setEnabled("media", false);
  assert.equal(off?.status, "disabled");
  assert.equal(off?.error, undefined);
  assert.equal((await h.setEnabled("media", false))?.status, "disabled");
  assert.deepEqual(events, [], "never initialized, never disposed");

  const sonosEvents: string[] = [];
  const h2 = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet });
  await h2.load([speakers(sonosEvents)]);
  assert.equal((await h2.setEnabled("sonos", true))?.status, "loaded");
  assert.deepEqual(sonosEvents, ["init"], "enabling a loaded module does not initialize it again");
});

test("an unknown id is not enabled or disabled", async () => {
  const enablement = new MemoryModuleEnablement();
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, enablement });
  await h.load([]);
  assert.equal(await h.setEnabled("nope", false), undefined);
  assert.equal(enablement.isEnabled("nope"), true, "nothing is stored for it");
});

test("enabling without configuration fails the module, keeps it enabled, and it fails the same way after a restart", async (t) => {
  const { core } = dataDir(t);
  const media = () => defineModule({ manifest: { id: "media", label: "Media", config: [{ key: "JELLYFIN_URL", required: true }] }, init() {} });
  const enablement = new SqliteModuleEnablement(core);
  enablement.set("media", false);
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, enablement });
  await h.load([media()]);
  assert.equal(h.loaded()[0].status, "disabled");

  const on = await h.setEnabled("media", true);
  assert.equal(on?.status, "failed");
  assert.match(on?.error ?? "", /JELLYFIN_URL/);
  assert.equal(enablement.isEnabled("media"), true);

  const restarted = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, enablement: new SqliteModuleEnablement(core) });
  await restarted.load([media()]);
  assert.equal(restarted.loaded()[0].status, "failed");
  assert.match(restarted.loaded()[0].error ?? "", /JELLYFIN_URL/);
});

test("enabling a module disabled from the start runs its migrations before init; its data survives a disable", async (t) => {
  const { database, core } = dataDir(t);
  const steps: string[] = [];
  let rows: unknown[] = [];
  const hello = defineModule({
    manifest: { id: "hello", label: "Hello" },
    migrations: [{ version: 1, name: "items", up: (db) => { steps.push("migration 1"); db.exec("CREATE TABLE hello__items (name TEXT NOT NULL)"); } }],
    init(ctx) {
      steps.push("init");
      rows = ctx.db.prepare("SELECT name FROM hello__items ORDER BY rowid").all().map((r) => r.name);
    },
  });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, database, enablement: new MemoryModuleEnablement(["hello"]) });
  await h.load([hello]);
  assert.equal(core.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'hello__items'").get()?.n, 0, "never migrated");

  assert.equal((await h.setEnabled("hello", true))?.status, "loaded");
  assert.deepEqual(steps, ["migration 1", "init"]);
  core.exec("INSERT INTO hello__items VALUES ('kept')");

  await h.setEnabled("hello", false);
  assert.equal((await h.setEnabled("hello", true))?.status, "loaded");
  assert.deepEqual(steps, ["migration 1", "init", "init"], "no migration runs again");
  assert.deepEqual(rows, ["kept"]);
  assert.equal(core.prepare("SELECT version FROM module_schema WHERE module_id = 'hello'").get()?.version, 1);
  await h.dispose();
});

test("disabling during a job run cancels the run and removes the jobs; history is kept and the jobs return on enable", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, { log() {} });
  const clock = new FakeClock(Date.parse("2026-09-28T12:00:00Z"));
  const store = new JobStore(db);
  const scheduler = new Scheduler({ store, clock, log: quiet, catchupDelayMs: 1000, graceMs: 1000 });
  const brain = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.jobs.schedule({ name: "nightly", cron: "0 3 * * *", run: ({ signal }) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
    },
  });
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, jobs: (id) => scheduler.forOwner(id) });
  await h.load([brain]);
  assert.equal(scheduler.runNow("brain/nightly").status, "started");

  await h.setEnabled("brain", false);
  assert.deepEqual(scheduler.list(), []);
  assert.deepEqual(store.runs("brain/nightly").map((r) => r.outcome), ["cancelled"]);

  await h.setEnabled("brain", true);
  assert.deepEqual(scheduler.list().map((j) => [j.owner, j.name]), [["brain", "nightly"]]);
  assert.equal(store.runs("brain/nightly").length, 1, "history kept across the disable");
  await h.dispose();
});

test("a manifest without an id fails only its module with the stored choices in place; startup goes on", async (t) => {
  const { core } = dataDir(t);
  const registry = new ToolRegistry(quiet);
  const nameless = defineModule({ manifest: { label: "No id" } as never, init() {} });
  const h = new ModuleHost(registry, { env: {}, log: quiet, enablement: new SqliteModuleEnablement(core) });
  await h.load([nameless, speakers([])]);
  assert.equal(h.loaded()[0].status, "failed");
  assert.equal(h.loaded()[1].status, "loaded");
  assert.deepEqual(registry.names(), ["sonos_play"]);
});

test("asking for the state a module is already in stores nothing", async (t) => {
  const { core } = dataDir(t);
  const h = new ModuleHost(new ToolRegistry(quiet), { env: {}, log: quiet, enablement: new SqliteModuleEnablement(core) });
  await h.load([speakers([])]);
  await h.setEnabled("sonos", true);
  assert.equal(core.prepare("SELECT count(*) AS n FROM module_enablement").get()?.n, 0);
});

test("shutdown waits for an enable in progress and tears that module down too; later calls change nothing", async () => {
  const events: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const slow = defineModule({
    manifest: { id: "travel", label: "Travel" },
    async init(ctx) {
      events.push("init");
      await gate;
      ctx.defineTool({ name: "get_travel_time", description: "", handler: () => ({}) });
    },
    dispose: () => void events.push("dispose"),
  });
  const registry = new ToolRegistry(quiet);
  const enablement = new MemoryModuleEnablement(["travel"]);
  const h = new ModuleHost(registry, { env: {}, log: quiet, enablement });
  await h.load([slow]);

  const enabling = h.setEnabled("travel", true);
  await new Promise((r) => setImmediate(r));
  const disposing = h.dispose();
  const later = h.setEnabled("travel", false);
  open();
  await enabling;
  await disposing;
  await later;
  assert.deepEqual(events, ["init", "dispose"], "initialized once, then torn down by the shutdown");
  assert.deepEqual(registry.names(), []);
  assert.equal(enablement.isEnabled("travel"), true, "the call made during shutdown stored nothing");
});

test("a disable that arrives during a reload waits for it, then tears the module down", async () => {
  const events: string[] = [];
  let gate: Promise<void> | undefined;
  let open!: () => void;
  const slow = defineModule({
    manifest: { id: "media", label: "Media" },
    async init(ctx) {
      events.push("init");
      if (gate) await gate;
      ctx.defineTool({ name: "media_play", description: "", handler: () => ({}) });
      events.push("ready");
    },
    dispose: () => void events.push("dispose"),
  });
  const registry = new ToolRegistry(quiet);
  const h = new ModuleHost(registry, { env: {}, log: quiet });
  await h.load([slow]);
  gate = new Promise<void>((r) => (open = r));

  const reloading = h.reload("media");
  const disabling = h.setEnabled("media", false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["init", "ready", "dispose", "init"], "the reload is mid-init and the disable has not started");
  open();
  assert.equal((await reloading)?.status, "loaded");
  assert.equal((await disabling)?.status, "disabled");
  assert.deepEqual(events, ["init", "ready", "dispose", "init", "ready", "dispose"]);
  assert.deepEqual(registry.names(), []);
});
