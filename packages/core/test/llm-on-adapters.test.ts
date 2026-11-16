/**
 * The spec's "on another adapter" scenarios (llm-adapters): a chat turn and a module call run end to end
 * through LlmService on each adapter, over scripted raw provider responses, and behave the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, ToolRegistry, type ConversationEntry } from "@friday/sdk";
import { ChatEngine, type ChatEvent } from "../src/chat/engine.js";
import { LlmService } from "../src/llm/service.js";
import type { ChatModel } from "../src/llm/types.js";
import { gemini, harnesses, openai } from "./adapter-harness.js";
import { setup } from "./conversation-fixtures.js";

const quiet = { log() {}, warn() {}, error() {} };
const ME = { id: "u1", name: "Raymond", role: "admin" } as const;

function service(model: ChatModel) {
  return new LlmService({ model, models: { standard: "std", fast: "fast" }, concurrency: 2, timeoutMs: 1000, retryDelaysMs: [5, 20], log: quiet });
}

/** One chat turn in which the model calls get_current_time and then answers, on the given adapter. */
async function chatTurn(model: ChatModel) {
  const s = setup();
  const registry = new ToolRegistry(quiet);
  registry.add("builtin", { name: "get_current_time", description: "The current time.", handler: () => ({ human: "ten" }) });
  const engine = new ChatEngine({ store: s.store, registry, llm: service(model), model: "chat-model", system: () => "CHAT PROMPT", toolTimeoutMs: 1000, log: quiet });
  const r = engine.begin({ text: "what time is it?" }, ME);
  if (!r.ok) throw new Error(r.error);
  const events: ChatEvent[] = [];
  await r.turn.run((e) => events.push(e));
  const id = r.turn.conversationId;
  const entries = s.store.get(id)!.entries.map(({ seq, at, ...rest }: ConversationEntry) => rest);
  // Conversation ids differ per run; everything else must match.
  const shown = events.map((e) => (e.event === "start" || e.event === "done" ? { event: e.event } : e));
  return { events: shown, entries };
}

const script = [{ calls: [{ id: "t1", name: "get_current_time", args: {} }] }, { text: ["It is ", "ten."] }] as const;

test("chat turn on another adapter: the tool runs, its result goes back, and the turn streams, records and ends the same", async () => {
  const onGemini = await chatTurn(gemini.make(...script).model);
  const onOpenai = await chatTurn(openai.make(...script).model);
  assert.deepEqual(onGemini.events, [
    { event: "start" },
    { event: "tool_call", data: { id: 1, name: "get_current_time", args: {} } },
    { event: "tool_result", data: { id: 1, name: "get_current_time", result: { human: "ten" } } },
    { event: "text", data: { text: "It is " } },
    { event: "text", data: { text: "ten." } },
    { event: "done" },
  ]);
  assert.deepEqual(onGemini.entries, [
    { kind: "user", input: "text", text: "what time is it?" },
    { kind: "tool", name: "get_current_time", args: {}, result: { human: "ten" }, truncated: false },
    { kind: "assistant", text: "It is ten.", interrupted: false },
  ]);
  assert.deepEqual(onOpenai, onGemini);
});

test("the tool's result reaches each provider paired with its call", async () => {
  for (const h of harnesses) {
    const { model, sent } = h.make(...script);
    await chatTurn(model);
    assert.deepEqual(h.results(sent[1]), [{ callId: "t1", name: "get_current_time", result: { human: "ten" } }], h.name);
  }
});

const schema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };

test("module call on another adapter: a schema request resolves with validated json", async () => {
  const { model, sent } = openai.make({ text: ['{"facts":["The boiler is a Remeha."]}'], usage: { input: 40, output: 9 } });
  const r = await service(model).forOwner("brain").generate<{ facts: string[] }>({ system: "Extract facts.", prompt: "We have a Remeha boiler.", schema });
  assert.deepEqual(r, { text: '{"facts":["The boiler is a Remeha."]}', json: { facts: ["The boiler is a Remeha."] }, model: "std", usage: { inputTokens: 40, outputTokens: 9, thoughtTokens: 0 } });
  assert.deepEqual(openai.schema(sent[0]), schema);
});

test("module call on another adapter: output that doesn't match the schema is invalid_output on both, carrying the raw text", async () => {
  for (const h of harnesses) {
    const { model } = h.make({ text: ['{"fact":"x"}'] });
    await assert.rejects(service(model).forOwner("brain").generate({ prompt: "p", schema }), (e) => e instanceof LlmError && e.kind === "invalid_output" && e.raw === '{"fact":"x"}', h.name);
    const cut = h.make({ text: ['{"facts":['], finish: "length" });
    await assert.rejects(service(cut.model).forOwner("brain").generate({ prompt: "p", schema }), (e) => e instanceof LlmError && e.kind === "invalid_output" && /truncated/.test(e.message), h.name);
  }
});
