import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "@friday/sdk";
import { ChatEngine } from "../src/chat/engine.js";
import { ConversationStore } from "../src/conversations/store.js";
import type { StreamChunk, StreamEnd } from "../src/llm/gemini.js";
import { setup } from "./conversation-fixtures.js";
import { admin, member, startAuthApp } from "./auth-harness.js";
import { startHarness } from "./helpers.js";

const quiet = { log() {}, warn() {}, error() {} };
const end: StreamEnd = { finishReason: "STOP", model: "m", usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } };
const answering = { async streamCall(_o: string, _r: unknown, onChunk: (c: StreamChunk) => void) { onChunk({ kind: "text", text: "hello", part: { text: "hello" } }); return end; } };

type Listed = { id: string; user: { id: string; name: string } | null };

async function chat(b: ReturnType<Awaited<ReturnType<typeof startAuthApp>>["browser"]>, text: string, conversationId?: string): Promise<string> {
  const res = await b.fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, conversationId }) });
  assert.equal(res.status, 200);
  const body = await res.text();
  return /"conversationId":"([^"]+)"/.exec(body)![1];
}

test("chat threads are their sender's: each user lists only their own, and others get 404 on read, delete and continue", async () => {
  const app = await startAuthApp({
    deps: ({ registry, db }) => ({
      chat: new ChatEngine({ store: new ConversationStore(db, { log: quiet }), registry, llm: answering, model: "m", system: () => "P", toolTimeoutMs: 1000, log: quiet }),
      conversations: new ConversationStore(db, { log: quiet }),
    }),
  });
  try {
    const sanne = app.browser();
    await sanne.login("/", member);
    const owner = app.browser();
    await owner.login("/", admin);
    const ids = new Map(app.users.list().map((u) => [u.name, u.id]));
    const hers = await chat(sanne, "hi");
    const theirs = await chat(owner, "hello");

    const list = async (b: typeof sanne) => ((await (await b.fetch("/api/conversations")).json()) as { conversations: Listed[] }).conversations;
    assert.deepEqual((await list(sanne)).map((c) => [c.id, c.user]), [[hers, { id: ids.get("Sanne"), name: "Sanne" }]]);
    assert.deepEqual((await list(owner)).map((c) => c.id), [theirs], "the admin owner sees only their own");
    const one = (await (await sanne.fetch(`/api/conversations/${hers}`)).json()) as Listed;
    assert.deepEqual(one.user, { id: ids.get("Sanne"), name: "Sanne" });

    // An admin can't look in: another user's thread is unknown to them.
    assert.equal((await owner.fetch(`/api/conversations/${hers}`)).status, 404);
    assert.equal((await owner.fetch(`/api/conversations/${hers}`, { method: "DELETE" })).status, 404);
    assert.equal((await sanne.fetch(`/api/conversations/${theirs}`)).status, 404);
    const res = await owner.fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "and more", conversationId: hers }) });
    assert.equal(res.status, 404);
    const after = (await (await sanne.fetch(`/api/conversations/${hers}`)).json()) as Listed & { entryCount: number };
    assert.equal(after.entryCount, 2, "nothing recorded");
  } finally {
    await app.close();
  }
});

test("a voice device's conversation has no user; older conversations have none either", () => {
  const { store } = setup();
  const device = store.create({ channel: "voice", device: "friday-kitchen" });
  const old = store.create({ channel: "chat" });
  const users = store.usersOf([device, old]);
  assert.deepEqual([users.get(device), users.get(old), users.size], [null, null, 2]);
  assert.equal(store.usersOf([]).size, 0);
});

test("the Talk page records its conversation for the connection's user; a chat turn without a user records none", async () => {
  const s = setup();
  s.db.exec("INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u2', 'i', 's', 'Sanne', 'member', 't', 't')");
  const metas: unknown[] = [];
  const { Auth } = await import("../src/auth/auth.js");
  const { UserStore } = await import("../src/auth/users.js");
  const { SessionStore } = await import("../src/auth/sessions.js");
  const users = new UserStore(s.db);
  const sessions = new SessionStore(s.db, Buffer.alloc(32, 1));
  const token = sessions.create("u2");
  const auth = new Auth({ mode: { kind: "oidc", oidc: { issuer: "i", clientId: "c", clientSecret: "s", userGroup: "u", adminGroup: "a" } }, users, sessions, publicUrl: () => "http://localhost" });
  const h = await startHarness({ auth, conversations: { recorder: (meta, log) => (metas.push(meta), s.store.recorder(meta, log)) } });
  try {
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(h.url, { headers: { cookie: `friday_session=${token}` } });
    await new Promise((r) => ws.once("open", r));
    ws.close();
    assert.deepEqual(metas, [{ channel: "voice", device: null, userId: "u2" }]);
  } finally {
    await h.close();
  }

  const engine = new ChatEngine({ store: s.store, registry: new ToolRegistry(quiet), llm: answering, model: "m", system: () => "P", toolTimeoutMs: 1000, log: quiet });
  const r = engine.begin({ text: "hi" });
  assert.ok(r.ok);
  await r.turn.run(() => {});
  assert.equal(s.store.usersOf([r.turn.conversationId]).get(r.turn.conversationId), null);
});
