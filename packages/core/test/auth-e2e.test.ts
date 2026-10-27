/**
 * The whole login story against the fake provider: the owner logs in first, a member after; the member chats, is
 * refused the setup, and is disabled by the owner, which ends their session and their Talk connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import type { ToolCallContext } from "@friday/sdk";
import { ChatEngine } from "../src/chat/engine.js";
import { ConversationStore } from "../src/conversations/store.js";
import type { StreamChunk, StreamEnd } from "../src/llm/gemini.js";
import { admin, member, quiet, startAuthApp } from "./auth-harness.js";
import { StubSession, waitFor } from "./helpers.js";

const end: StreamEnd = { finishReason: "STOP", model: "m", usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } };

/** First round calls `whoami`, the second answers. */
function llm() {
  let round = 0;
  return {
    async streamCall(_o: string, _r: unknown, onChunk: (c: StreamChunk) => void): Promise<StreamEnd> {
      if (round++ % 2 === 0) onChunk({ kind: "call", name: "whoami", args: {}, part: { functionCall: { name: "whoami", args: {} } } });
      else onChunk({ kind: "text", text: "You are you.", part: { text: "You are you." } });
      return end;
    },
  };
}

test("owner and member: login, chat as the member, setup refused, disabled by the owner", async () => {
  StubSession.instances = [];
  const calls: ToolCallContext[] = [];
  const app = await startAuthApp({
    talk: true,
    deps: ({ registry, db }) => {
      registry.add("probe", { name: "whoami", description: "", handler: (_a, c) => (calls.push(c), { ok: true }) });
      const store = new ConversationStore(db, { log: quiet });
      return { conversations: store, chat: new ChatEngine({ store, registry, llm: llm(), model: "m", system: () => "P", toolTimeoutMs: 1000, log: quiet }) };
    },
  });
  try {
    // The owner logs in first and becomes the owner.
    const owner = app.browser();
    assert.equal((await owner.login("/", admin)).status, 302);
    const ownerMe = (await (await owner.fetch("/api/me")).json()) as { id: string; owner: boolean; role: string };
    assert.deepEqual([ownerMe.role, ownerMe.owner], ["admin", true]);

    // A member logs in, chats, and the chat is theirs.
    const sanne = app.browser();
    assert.equal((await sanne.login("/chat", member)).headers.get("location"), "/chat");
    const sanneId = ((await (await sanne.fetch("/api/me")).json()) as { id: string }).id;
    const res = await sanne.fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "who am I?" }) });
    const stream = await res.text();
    assert.match(stream, /event: done/);
    const conversationId = /"conversationId":"([^"]+)"/.exec(stream)![1];
    assert.deepEqual(calls.map((c) => c.user), [{ id: sanneId, name: "Sanne" }], "the tool call is for the member");
    const listed = (await (await owner.fetch(`/api/conversations/${conversationId}`)).json()) as { user: unknown };
    assert.deepEqual(listed.user, { id: sanneId, name: "Sanne" });

    // The member may not touch the household's setup.
    assert.equal((await sanne.fetch("/api/config")).status, 403);
    assert.equal((await sanne.fetch("/api/users")).status, 403);

    // The member opens the Talk page.
    const cookie = [...sanne.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const ws = new WebSocket(`${app.base.replace("http", "ws")}/ws/audio`, { headers: { cookie } });
    await once(ws, "open");
    await waitFor(() => StubSession.instances.length === 1);
    assert.deepEqual(StubSession.instances[0].user, { id: sanneId, name: "Sanne" });
    const closed = once(ws, "close");

    // The owner disables the member: the session and the Talk connection end at once.
    assert.equal((await owner.fetch(`/api/users/${sanneId}/disable`, { method: "POST" })).status, 200);
    const [code] = (await closed) as [number];
    assert.equal(code, 4401);
    assert.equal((await sanne.fetch("/api/me")).status, 401);
    assert.equal((await app.browser().login("/", member)).status, 403, "their next login is refused");
    assert.equal((await owner.fetch("/api/me")).status, 200, "the owner is unaffected");
  } finally {
    await app.close();
  }
});
