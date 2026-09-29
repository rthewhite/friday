import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { runRemote } from "@friday/sdk/remote";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { migrate, migrations } from "../src/storage/db.js";
import { ConfigStore } from "../src/secrets/config-store.js";
import { createResolver } from "../src/secrets/resolver.js";
import { CompositeKeyStore, EnvKeyStore, SqliteKeyStore } from "../src/remote/key-store.js";
import { RemoteHost } from "../src/remote/host.js";
import { SqliteModuleStorage } from "../src/storage/module-kv.js";
import { ConversationStore } from "../src/conversations/store.js";
import { waitFor } from "./helpers.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { coreConfig, followTimezone } from "../src/core-config.js";

const quiet = { log() {}, warn() {}, error() {} };

/** One recorded voice exchange through a recorder; returns the recorder (still live unless `end`). */
function talk(store: ConversationStore, end?: string) {
  const r = store.recorder({ channel: "voice", device: "kitchen" });
  r.user(" Play Dune.", "speech");
  r.tool("media_play", { query: "Dune" }).result({ playing: "Dune" });
  r.assistant("Playing Dune.");
  r.turnComplete();
  if (end) r.end(end);
  return r;
}

/** Entries requested by modules (the tests below predate core's own keys). */
const moduleEntries = (cfg: { entries: Array<{ modules: Array<{ id: string }> }> }) => cfg.entries.filter((e) => !e.modules.some((m) => m.id === "core"));

async function start(opts: { masterKey?: Buffer | undefined; env?: Record<string, string>; envKeys?: string; withJobs?: boolean; onConfigChange?: (scope: string, key: string) => void } = {}) {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const env = opts.env ?? {};
  const configStore = new ConfigStore(db, "masterKey" in opts ? opts.masterKey : randomBytes(32), quiet);
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env, log: quiet, resolve: createResolver(configStore, env), storage: (id) => new SqliteModuleStorage(db, id) });
  const media = defineModule({
    manifest: { id: "media", label: "Media", config: [{ key: "JELLYFIN_URL", required: true, description: "url" }, { key: "HA_URL" }, { key: "HA_TOKEN", secret: true }] },
    init(ctx) { ctx.defineTool({ name: "search", description: "", handler: () => ({ url: ctx.config.get("JELLYFIN_URL"), ha: ctx.config.get("HA_URL"), tok: ctx.config.get("HA_TOKEN") }) }); },
  });
  const plain = defineModule({ manifest: { id: "plain", label: "Plain", config: [{ key: "HA_URL", required: true, description: "also here" }] }, init() {} });
  await host.load([media, plain]);
  const keys = new SqliteKeyStore(db);
  const conversations = new ConversationStore(db, { log: quiet });
  const remote = new RemoteHost({ registry, keys: new CompositeKeyStore([keys, new EnvKeyStore(opts.envKeys)]), pingMs: 0, log: quiet });
  // Built as server.ts builds it: cron's zone from core's resolver, re-planned when FRIDAY_TIMEZONE is saved.
  const jobs = opts.withJobs ? new Scheduler({ store: new JobStore(db), log: quiet, timezone: () => coreConfig(configStore, env)("FRIDAY_TIMEZONE"), graceMs: 100 }) : undefined;
  const onConfigChange = opts.onConfigChange ?? (jobs ? followTimezone(jobs) : undefined);
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, undefined, { log: quiet }), remote, webDir: "/nonexistent", configStore, keys, env, conversations, jobs, onConfigChange }));
  remote.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const j = (path: string, init?: RequestInit) => fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { base, ws: `ws://127.0.0.1:${port}/ws/modules`, j, registry, remote, conversations, configStore, jobs, close: async () => { await jobs?.stop(); await remote.closeAll(); server.close(); await once(server, "close"); } };
}

test("conversations: list summary shape and the full conversation with entries", async () => {
  const s = await start();
  try {
    const id = talk(s.conversations, "ended: done").conversationId!;
    const list = await (await s.j("/api/conversations")).json();
    assert.equal(list.next, null);
    assert.equal(list.conversations.length, 1);
    const c = list.conversations[0];
    assert.match(c.startedAt, /^\d{4}-/);
    assert.deepEqual(c, {
      id, channel: "voice", device: "kitchen", startedAt: c.startedAt, lastActivityAt: c.lastActivityAt, endedAt: c.endedAt, endReason: "ended: done",
      quietAt: c.quietAt, state: "quiet", entryCount: 3, preview: "Play Dune.",
    });
    const full = await (await s.j(`/api/conversations/${id}`)).json();
    assert.deepEqual(full.entries.map(({ seq, at, ...e }: any) => e), [
      { kind: "user", input: "speech", text: "Play Dune." },
      { kind: "tool", name: "media_play", args: { query: "Dune" }, result: { playing: "Dune" }, truncated: false },
      { kind: "assistant", text: "Playing Dune.", interrupted: false },
    ]);
    assert.equal((await s.j("/api/conversations/nope")).status, 404);
    assert.equal((await s.j("/api/conversations/nope", { method: "DELETE" })).status, 404);
    assert.equal((await s.j("/api/conversations?before=garbage")).status, 400);
  } finally {
    await s.close();
  }
});

test("conversations: paging over 120 rows with the before cursor", async () => {
  const s = await start();
  try {
    for (let i = 0; i < 120; i++) s.conversations.create({ channel: "chat" });
    const first = await (await s.j("/api/conversations")).json();
    assert.equal(first.conversations.length, 50);
    const second = await (await s.j(`/api/conversations?before=${encodeURIComponent(first.next)}`)).json();
    assert.equal(second.conversations.length, 50);
    const third = await (await s.j(`/api/conversations?limit=50&before=${encodeURIComponent(second.next)}`)).json();
    assert.equal(third.conversations.length, 20);
    assert.equal(third.next, null);
    const ids = [...first.conversations, ...second.conversations, ...third.conversations].map((c: any) => c.id);
    assert.equal(new Set(ids).size, 120);
    assert.equal((await (await s.j("/api/conversations?limit=7")).json()).conversations.length, 7);
  } finally {
    await s.close();
  }
});

test("conversations: ?channel= filters, keeps the filter when paging, and rejects unknown channels", async () => {
  const s = await start();
  try {
    for (let i = 0; i < 60; i++) s.conversations.create({ channel: i % 2 ? "chat" : "voice" });
    const first = await (await s.j("/api/conversations?channel=chat&limit=20")).json();
    assert.equal(first.conversations.length, 20);
    const second = await (await s.j(`/api/conversations?channel=chat&limit=20&before=${encodeURIComponent(first.next)}`)).json();
    assert.equal(second.conversations.length, 10);
    assert.equal(second.next, null);
    assert.ok([...first.conversations, ...second.conversations].every((c: any) => c.channel === "chat"));
    const voice = await (await s.j("/api/conversations?channel=voice")).json();
    assert.equal(voice.conversations.length, 30);
    assert.equal((await s.j("/api/conversations?channel=email")).status, 400);
  } finally {
    await s.close();
  }
});

test("conversations: DELETE answers 409 while the session records, then 204, then the conversation is gone", async () => {
  const s = await start();
  try {
    const r = talk(s.conversations);
    const id = r.conversationId!;
    const live = await s.j(`/api/conversations/${id}`, { method: "DELETE" });
    assert.equal(live.status, 409);
    assert.equal((await s.j(`/api/conversations/${id}`)).status, 200);
    r.end("client closed");
    assert.equal((await s.j(`/api/conversations/${id}`, { method: "DELETE" })).status, 204);
    assert.equal((await s.j(`/api/conversations/${id}`)).status, 404);
  } finally {
    await s.close();
  }
});

test("config listing, set, reload, delete; plain values are visible, secrets never leave the server", async () => {
  const s = await start({ env: { HA_URL: "http://env-ha", HA_TOKEN: "env-tok" } });
  try {
    let cfg = await (await s.j("/api/config")).json();
    assert.equal(cfg.secretsEnabled, true);
    assert.deepEqual(moduleEntries(cfg), [
      { key: "JELLYFIN_URL", secret: false, required: true, description: "url", modules: [{ id: "media", required: true }], status: "pending" },
      { key: "HA_URL", secret: false, required: true, description: "also here", modules: [{ id: "media", required: false }, { id: "plain", required: true }], status: "env", value: "http://env-ha" },
      { key: "HA_TOKEN", secret: true, required: false, modules: [{ id: "media", required: false }], status: "env" },
    ]);
    assert.equal((await s.j("/api/modules")).ok, true);
    assert.equal(((await (await s.j("/api/modules")).json()) as any[])[0].status, "failed");

    assert.equal((await s.j("/api/config/media/JELLYFIN_URL", { method: "PUT", body: JSON.stringify({ value: "http://jf" }) })).status, 204);
    assert.equal((await s.j("/api/config/nope/X", { method: "PUT", body: JSON.stringify({ value: "1" }) })).status, 404);
    assert.equal((await s.j("/api/config/media/X", { method: "PUT", body: JSON.stringify({ value: "" }) })).status, 400);
    assert.equal((await s.j("/api/config/media/X", { method: "PUT", body: "{nope" })).status, 400);
    assert.equal((await s.j("/api/config/global/HA_URL", { method: "PUT", body: JSON.stringify({ value: "http://global-ha" }) })).status, 204);

    // declared secret cannot be downgraded; undeclared global defaults to plain unless asked
    assert.equal((await s.j("/api/config/media/HA_TOKEN", { method: "PUT", body: JSON.stringify({ value: "tok", secret: false }) })).status, 204);
    assert.equal((await s.j("/api/config/global/EXTRA_SECRET", { method: "PUT", body: JSON.stringify({ value: "shh", secret: true }) })).status, 204);

    cfg = await (await s.j("/api/config")).json();
    const strip = (e: any) => { const { updatedAt, ...rest } = e; assert.match(updatedAt, /^\d{4}-/); return rest; };
    assert.deepEqual(strip(moduleEntries(cfg)[0]), { key: "JELLYFIN_URL", secret: false, required: true, description: "url", modules: [{ id: "media", required: true }], status: "set", scope: "media", value: "http://jf" });
    assert.deepEqual(strip(moduleEntries(cfg)[1]), { key: "HA_URL", secret: false, required: true, description: "also here", modules: [{ id: "media", required: false }, { id: "plain", required: true }], status: "set", scope: "global", value: "http://global-ha" });
    assert.deepEqual(strip(moduleEntries(cfg)[2]), { key: "HA_TOKEN", secret: true, required: false, modules: [{ id: "media", required: false }], status: "set", scope: "media" });
    assert.deepEqual(strip(cfg.entries.at(-1)), { key: "EXTRA_SECRET", secret: true, required: false, modules: [], status: "set", scope: "global" });
    assert.ok(!JSON.stringify(cfg).includes("tok") && !JSON.stringify(cfg).includes("shh"), "secret values are not returned");

    const reloaded = await (await s.j("/api/modules/media/reload", { method: "POST" })).json();
    assert.equal(reloaded.status, "loaded");
    assert.deepEqual(reloaded.tools, ["search"]);
    assert.deepEqual((await s.registry.callTool("search", {})).result, { url: "http://jf", ha: "http://global-ha", tok: "tok" });
    assert.equal((await s.j("/api/modules/nope/reload", { method: "POST" })).status, 404);

    assert.equal((await s.j("/api/config/global/HA_URL", { method: "DELETE" })).status, 204);
    assert.deepEqual((await s.registry.callTool("search", {})).result, { url: "http://jf", ha: "http://env-ha", tok: "tok" });
    // an undeclared plain global shows up under module "global" with its value
    await s.j("/api/config/global/EXTRA", { method: "PUT", body: JSON.stringify({ value: "x" }) });
    cfg = await (await s.j("/api/config")).json();
    const extra = cfg.entries.find((e: any) => e.key === "EXTRA");
    delete extra.updatedAt;
    assert.deepEqual(extra, { key: "EXTRA", secret: false, required: false, modules: [], status: "set", scope: "global", value: "x" });
  } finally {
    await s.close();
  }
});

test("no master key: secretsEnabled=false, plain PUT works, secret PUT answers 503", async () => {
  const s = await start({ masterKey: undefined, env: { JELLYFIN_URL: "http://env" } });
  try {
    const cfg = await (await s.j("/api/config")).json();
    assert.equal(cfg.secretsEnabled, false);
    assert.deepEqual(moduleEntries(cfg)[0], { key: "JELLYFIN_URL", secret: false, required: true, description: "url", modules: [{ id: "media", required: true }], status: "env", value: "http://env" });
    assert.equal((await s.j("/api/config/media/JELLYFIN_URL", { method: "PUT", body: JSON.stringify({ value: "http://stored" }) })).status, 204);
    assert.equal(moduleEntries(await (await s.j("/api/config")).json())[0].value, "http://stored");
    const put = await s.j("/api/config/media/HA_TOKEN", { method: "PUT", body: JSON.stringify({ value: "x" }) });
    assert.equal(put.status, 503);
    assert.match((await put.json()).error, /FRIDAY_MASTER_KEY/);
  } finally {
    await s.close();
  }
});

test("keys: create returns plaintext once, listing hides it, stored key authenticates a remote, revoke disconnects it", async () => {
  const s = await start({ envKeys: "legacy=envkey" });
  const mod = defineModule({ manifest: { id: "sim", label: "Sim" }, init(ctx) { ctx.defineTool({ name: "pos", description: "", handler: () => ({ p: 1 }) }); } });
  let handle: ReturnType<typeof runRemote> | undefined;
  try {
    assert.equal((await s.j("/api/keys", { method: "POST", body: JSON.stringify({ moduleId: "Bad Id" }) })).status, 400);
    const created = await s.j("/api/keys", { method: "POST", body: JSON.stringify({ moduleId: "sim", label: "gaming pc" }) });
    assert.equal(created.status, 201);
    const rec = await created.json();
    assert.equal(rec.moduleId, "sim");
    assert.equal(rec.label, "gaming pc");
    assert.equal(typeof rec.key, "string");
    const list = await (await s.j("/api/keys")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].key, undefined);
    assert.equal(list[0].lastSeenAt, null);

    handle = runRemote(mod, { url: s.ws, key: rec.key, env: {}, log: quiet, minBackoffMs: 10, maxBackoffMs: 20 });
    await handle.connected();
    await waitFor(() => s.registry.names().includes("sim__pos"));
    assert.notEqual(((await (await s.j("/api/keys")).json()) as any[])[0].lastSeenAt, null);

    // env fallback still works alongside stored keys
    const legacy = runRemote(defineModule({ manifest: { id: "legacy", label: "L" }, init() {} }), { url: s.ws, key: "envkey", env: {}, log: quiet });
    await legacy.connected();
    await legacy.stop();

    assert.equal((await s.j(`/api/keys/${rec.id}`, { method: "DELETE" })).status, 204);
    await waitFor(() => !s.registry.names().includes("sim__pos"));
    assert.equal(((await (await s.j("/api/keys")).json()) as any[])[0].revoked, true);
    assert.equal((await s.j(`/api/keys/${rec.id}`, { method: "DELETE" })).status, 404);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(s.remote.connected().length, 0, "the runner does not get back in with a revoked key");
  } finally {
    await handle?.stop();
    await s.close();
  }
});

test("jobs API: listing, runs newest first, run now 202, conflict 409, unknown 404", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const store = new JobStore(db);
  const jobs = new Scheduler({ store, log: quiet, timezone: "Europe/Amsterdam", graceMs: 100 });
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet, enabled: "brain,broken", jobs: (id) => jobs.forOwner(id) });
  let release: (() => void) | undefined;
  const brain = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.jobs.schedule({ name: "nightly", description: "Turns transcripts into memory", cron: "0 3 * * *", run: () => new Promise<{ summary: string }>((r) => (release = () => r({ summary: "12 memories" }))) });
      ctx.jobs.schedule({ name: "poll", everyMs: 900_000, run: () => { throw new Error("jellyfin unreachable"); } });
    },
  });
  const broken = defineModule({ manifest: { id: "broken", label: "B" }, init(ctx) { ctx.jobs.schedule({ name: "x", everyMs: 1000, run() {} }); throw new Error("no"); } });
  const off = defineModule({ manifest: { id: "off", label: "Off" }, init(ctx) { ctx.jobs.schedule({ name: "x", everyMs: 1000, run() {} }); } });
  await host.load([brain, broken, off]);
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, undefined, { log: quiet }), webDir: "/nonexistent", jobs }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string) => fetch(base + path, { method: "POST" });
  try {
    let list = (await (await fetch(base + "/api/jobs")).json()) as any[];
    assert.deepEqual(list.map((j) => j.id), ["brain/nightly", "brain/poll"], "disabled and failed modules' jobs are not listed");
    assert.deepEqual(list[0], {
      id: "brain/nightly", owner: "brain", name: "nightly", description: "Turns transcripts into memory",
      schedule: { cron: "0 3 * * *", timezone: "Europe/Amsterdam" }, nextRunAt: list[0].nextRunAt, running: false, lastRun: null,
    });
    assert.ok(Date.parse(list[0].nextRunAt) > Date.now());
    assert.deepEqual(list[1].schedule, { everyMs: 900_000 });

    assert.equal((await post("/api/jobs/brain/poll/run")).status, 202);
    await waitFor(() => store.lastRun("brain/poll") !== undefined);
    const started = await post("/api/jobs/brain/nightly/run");
    assert.equal(started.status, 202);
    const { runId } = (await started.json()) as { runId: string };
    assert.equal((await post("/api/jobs/brain/nightly/run")).status, 409);
    list = (await (await fetch(base + "/api/jobs")).json()) as any[];
    assert.equal(list[0].running, true);
    assert.match(list[0].runningSince, /^\d{4}-/);
    assert.equal(list[1].lastRun.outcome, "failed");
    assert.equal(list[1].lastRun.error, "jellyfin unreachable");
    release!();
    await waitFor(() => store.lastRun("brain/nightly") !== undefined);
    list = (await (await fetch(base + "/api/jobs")).json()) as any[];
    assert.equal(list[0].running, false);
    assert.equal(list[0].lastRun.outcome, "ok");
    assert.equal(list[0].lastRun.summary, "12 memories");

    assert.equal((await post("/api/jobs/brain/nightly/run")).status, 202);
    await waitFor(() => typeof release === "function");
    release!();
    await waitFor(() => store.runs("brain/nightly").every((r) => r.outcome !== "running"));
    const runs = (await (await fetch(base + "/api/jobs/brain/nightly/runs")).json()) as any[];
    assert.equal(runs.length, 2);
    assert.equal(runs[1].id, runId, "newest first");
    assert.deepEqual(Object.keys(runs[1]).sort(), ["durationMs", "finishedAt", "id", "jobId", "outcome", "startedAt", "summary", "trigger"]);
    assert.equal(runs[1].trigger, "manual");

    assert.equal((await fetch(base + "/api/jobs/brain/nope/runs")).status, 404);
    assert.equal((await post("/api/jobs/off/x/run")).status, 404);
    assert.equal((await post("/api/jobs/nope/x/run")).status, 404);
  } finally {
    await jobs.stop();
    server.close();
    await once(server, "close");
  }
});

test("core requests GEMINI_API_KEY: listed as a secret, storable for core, never downgraded", async () => {
  const s = await start({ env: { GEMINI_API_KEY: "env-key" } });
  try {
    const core = async () => (await (await s.j("/api/config")).json()).entries.find((e: any) => e.key === "GEMINI_API_KEY");
    assert.deepEqual(await core(), { key: "GEMINI_API_KEY", secret: true, required: true, description: "Gemini API key for voice sessions and text generation", modules: [{ id: "core", required: true }], status: "env" });
    assert.equal((await s.j("/api/config/core/GEMINI_API_KEY", { method: "PUT", body: JSON.stringify({ value: "portal-key" }) })).status, 204);
    const stored = await core();
    assert.equal(stored.status, "set");
    assert.equal(stored.scope, "core");
    assert.equal(stored.value, undefined);
    assert.equal(s.configStore.info("core", "GEMINI_API_KEY")?.secret, true);
    assert.equal((await s.j("/api/config/global/GEMINI_API_KEY", { method: "PUT", body: JSON.stringify({ value: "g", secret: false }) })).status, 204);
    assert.equal(s.configStore.info("global", "GEMINI_API_KEY")?.secret, true);
    assert.equal((await s.j("/api/config/nope/GEMINI_API_KEY", { method: "PUT", body: JSON.stringify({ value: "x" }) })).status, 404);
  } finally {
    await s.close();
  }
});

test("core requests FRIDAY_TIMEZONE as a plain, optional key", async () => {
  const s = await start();
  try {
    const entry = (await (await s.j("/api/config")).json()).entries.find((e: any) => e.key === "FRIDAY_TIMEZONE");
    assert.deepEqual(entry, { key: "FRIDAY_TIMEZONE", secret: false, required: false, description: "IANA zone for cron job schedules (default Europe/Amsterdam)", modules: [{ id: "core", required: false }], status: "pending" });
  } finally {
    await s.close();
  }
});

test("a stored or deleted config value is reported to onConfigChange; a rejected write is not", async () => {
  const changes: string[] = [];
  const s = await start({ onConfigChange: (scope, key) => void changes.push(`${scope}/${key}`) });
  try {
    assert.equal((await s.j("/api/config/global/FRIDAY_TIMEZONE", { method: "PUT", body: JSON.stringify({ value: "Asia/Tokyo" }) })).status, 204);
    assert.equal((await s.j("/api/config/media/HA_URL", { method: "DELETE" })).status, 204);
    assert.equal((await s.j("/api/config/global/FRIDAY_TIMEZONE", { method: "PUT", body: JSON.stringify({ value: "" }) })).status, 400);
    assert.equal((await s.j("/api/config/nope/FRIDAY_TIMEZONE", { method: "PUT", body: JSON.stringify({ value: "UTC" }) })).status, 404);
    assert.deepEqual(changes, ["global/FRIDAY_TIMEZONE", "media/HA_URL"]);
  } finally {
    await s.close();
  }
});

test("saving FRIDAY_TIMEZONE globally re-plans cron at once, and clearing it falls back to the environment", async () => {
  const s = await start({ withJobs: true, env: { FRIDAY_TIMEZONE: "Europe/Amsterdam" } });
  const localTime = (iso: string, timeZone: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
  const nightly = async () => ((await (await s.j("/api/jobs")).json()) as any[]).find((j) => j.id === "core/nightly");
  try {
    s.jobs!.register("core", { name: "nightly", cron: "0 3 * * *", run: () => {} });
    assert.equal((await nightly()).schedule.timezone, "Europe/Amsterdam");

    assert.equal((await s.j("/api/config/global/FRIDAY_TIMEZONE", { method: "PUT", body: JSON.stringify({ value: "America/New_York" }) })).status, 204);
    const moved = await nightly();
    assert.deepEqual(moved.schedule, { cron: "0 3 * * *", timezone: "America/New_York" });
    assert.equal(localTime(moved.nextRunAt, "America/New_York"), "03:00");

    assert.equal((await s.j("/api/config/global/FRIDAY_TIMEZONE", { method: "DELETE" })).status, 204);
    const back = await nightly();
    assert.equal(back.schedule.timezone, "Europe/Amsterdam", "the environment value applies again");
    assert.equal(localTime(back.nextRunAt, "Europe/Amsterdam"), "03:00");
  } finally {
    await s.close();
  }
});
