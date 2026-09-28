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

async function start(opts: { masterKey?: Buffer | undefined; env?: Record<string, string>; envKeys?: string } = {}) {
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
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, quiet), remote, webDir: "/nonexistent", configStore, keys, env, conversations }));
  remote.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const j = (path: string, init?: RequestInit) => fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { base, ws: `ws://127.0.0.1:${port}/ws/modules`, j, registry, remote, conversations, close: async () => { await remote.closeAll(); server.close(); await once(server, "close"); } };
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
    assert.deepEqual(cfg.entries, [
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
    assert.deepEqual(strip(cfg.entries[0]), { key: "JELLYFIN_URL", secret: false, required: true, description: "url", modules: [{ id: "media", required: true }], status: "set", scope: "media", value: "http://jf" });
    assert.deepEqual(strip(cfg.entries[1]), { key: "HA_URL", secret: false, required: true, description: "also here", modules: [{ id: "media", required: false }, { id: "plain", required: true }], status: "set", scope: "global", value: "http://global-ha" });
    assert.deepEqual(strip(cfg.entries[2]), { key: "HA_TOKEN", secret: true, required: false, modules: [{ id: "media", required: false }], status: "set", scope: "media" });
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
    assert.deepEqual(cfg.entries[0], { key: "JELLYFIN_URL", secret: false, required: true, description: "url", modules: [{ id: "media", required: true }], status: "env", value: "http://env" });
    assert.equal((await s.j("/api/config/media/JELLYFIN_URL", { method: "PUT", body: JSON.stringify({ value: "http://stored" }) })).status, 204);
    assert.equal(((await (await s.j("/api/config")).json()).entries[0]).value, "http://stored");
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
