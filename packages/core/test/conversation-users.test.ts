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

test("chat threads record their sender, the API shows the user, and nothing is filtered by it", async () => {
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

    const { conversations } = (await (await sanne.fetch("/api/conversations")).json()) as { conversations: Listed[] };
    assert.deepEqual(
      new Map(conversations.map((c) => [c.id, c.user])),
      new Map([[hers, { id: ids.get("Sanne"), name: "Sanne" }], [theirs, { id: ids.get("Owner"), name: "Owner" }]]),
      "a member lists everyone's threads",
    );
    const one = (await (await owner.fetch(`/api/conversations/${hers}`)).json()) as Listed;
    assert.deepEqual(one.user, { id: ids.get("Sanne"), name: "Sanne" });

    // Continued by someone else, the thread keeps the user who started it.
    await chat(owner, "and more", hers);
    const again = (await (await owner.fetch(`/api/conversations/${hers}`)).json()) as Listed;
    assert.deepEqual(again.user, { id: ids.get("Sanne"), name: "Sanne" });
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
