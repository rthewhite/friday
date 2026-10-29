import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, ToolRegistry, type PromptContextInfo, type RouteRequest, type ToolCallContext } from "@friday/sdk";
import { ChatEngine } from "../src/chat/engine.js";
import type { StreamChunk, StreamEnd } from "../src/llm/gemini.js";
import { createPromptContext, systemPrompt } from "../src/prompt-context.js";
import { setup } from "./conversation-fixtures.js";
import { admin, member, startAuthApp } from "./auth-harness.js";

const quiet = { log() {}, warn() {}, error() {} };
const end: StreamEnd = { finishReason: "STOP", model: "m", usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } };

/** One round calling tool `who`, then a round answering. */
function llmCallingWho() {
  let round = 0;
  return {
    async streamCall(_owner: string, _req: unknown, onChunk: (c: StreamChunk) => void): Promise<StreamEnd> {
      if (round++ === 0) onChunk({ kind: "call", name: "who", args: {}, part: { functionCall: { name: "who", args: {} } } });
      else onChunk({ kind: "text", text: "ok", part: { text: "ok" } });
      return end;
    },
  };
}

test("a chat turn's tool calls and system prompt are for the user who sent the message", async () => {
  const s = setup();
  const registry = new ToolRegistry(quiet);
  const calls: ToolCallContext[] = [];
  registry.add("probe", { name: "who", description: "", handler: (_a, c) => (calls.push(c), {}) });
  const systems: unknown[] = [];
  const engine = new ChatEngine({ store: s.store, registry, llm: llmCallingWho(), model: "m", system: (u) => (systems.push(u), "P"), toolTimeoutMs: 1000, log: quiet });
  const r = engine.begin({ text: "hi" }, { id: "u2", name: "Sanne", role: "member" } as never);
  assert.ok(r.ok);
  await r.turn.run(() => {});
  assert.deepEqual(calls, [{ channel: "chat", conversationId: r.turn.conversationId, user: { id: "u2", name: "Sanne" } }]);
  assert.deepEqual(systems, [{ id: "u2", name: "Sanne" }]);
});

test("prompt context gets the user for chat and the Talk page, and the owner for a voice device", () => {
  const context = createPromptContext({ log: quiet });
  const seen: PromptContextInfo[] = [];
  context.forOwner("probe").addContext((info) => (seen.push(info), undefined));
  systemPrompt(context, "chat", undefined, { id: "u2", name: "Sanne" })();
  systemPrompt(context, "voice", undefined, { id: "u2", name: "Sanne" })();
  systemPrompt(context, "voice", { id: "friday-kitchen", label: "Kitchen", area: null, notes: null }, { id: "u1", name: "Raymond" })();
  systemPrompt(context, "voice", { id: "friday-kitchen", label: "Kitchen", area: null, notes: null })();
  assert.deepEqual(seen, [
    { channel: "chat", user: { id: "u2", name: "Sanne" } },
    { channel: "voice", user: { id: "u2", name: "Sanne" } },
    { channel: "voice", user: { id: "u1", name: "Raymond" } },
    { channel: "voice" },
  ]);
});

test("module routes see the user who made the request, with their role", async () => {
  const seen: RouteRequest["user"][] = [];
  const probe = defineModule({
    manifest: { id: "probe", label: "Probe" },
    init(ctx) {
      ctx.http.route("GET", "who", (req, res) => {
        seen.push(req.user);
        res.json({});
      });
    },
  });
  const app = await startAuthApp({ modules: [probe] });
  try {
    const sanne = app.browser();
    await sanne.login("/", member);
    const owner = app.browser();
    await owner.login("/", admin);
    assert.equal((await sanne.fetch("/api/modules/probe/who")).status, 200);
    assert.equal((await owner.fetch("/api/modules/probe/who")).status, 200);
    const ids = new Map(app.users.list().map((u) => [u.name, u.id]));
    assert.deepEqual(seen, [
      { id: ids.get("Sanne"), name: "Sanne", role: "member" },
      { id: ids.get("Owner"), name: "Owner", role: "admin" },
    ]);
  } finally {
    await app.close();
  }
});
