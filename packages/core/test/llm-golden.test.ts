/**
 * Golden Gemini requests: what core sent to Gemini before the provider-neutral layer (llm-adapters).
 * Each fixture in test/fixtures/gemini-golden/ holds a case's input (in the pre-adapter form it was
 * recorded from) and the Gemini parameters or contents it produced. The same cases, built as neutral
 * requests, must still produce exactly these through the Gemini adapter. The fixtures are never rewritten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GenerateContentResponse, Part } from "@google/genai";
import { Type, type ConversationEntry } from "@friday/sdk";
import { toMessages } from "../src/chat/history.js";
import { GeminiAdapter, geminiParams } from "../src/llm/gemini.js";
import type { ChatMessage, ChatRequest, ModelEnd } from "../src/llm/types.js";

const dir = new URL("./fixtures/gemini-golden/", import.meta.url);

/** Compares `output` with the stored fixture's output. */
function golden(name: string, output: unknown): void {
  const stored = JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(output)), stored.output);
}

const schema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };

export const tools = [
  {
    name: "set_light",
    description: "Turns a light on or off.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        entity: { type: Type.STRING, description: "The light." },
        on: { type: Type.BOOLEAN },
        level: { type: Type.INTEGER, nullable: true },
        mode: { type: Type.STRING, enum: ["warm", "cold"] },
        rooms: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["entity", "on"],
    },
  },
  { name: "get_current_time", description: "The current time." },
  { name: "mcp_search", description: "Searches.", parametersJsonSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
];

test("golden: a prompt with system, schema, temperature and output limit", () => {
  const req: ChatRequest = { model: "gemini-flash-latest", system: "Be brief.", messages: [{ role: "user", text: "hi" }], schema, temperature: 0.2, maxOutputTokens: 100 };
  golden("generate-prompt", geminiParams(req));
});

test("golden: messages with user and model turns", () => {
  const req: ChatRequest = { model: "m", messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }] };
  golden("generate-messages", geminiParams(req));
});

test("golden: a streamed request with tools and thoughts", () => {
  golden("stream-tools-thoughts", geminiParams({ model: "m", system: "sys", messages: [{ role: "user", text: "hi" }], tools, thoughts: true }));
  golden("stream-bare", geminiParams({ model: "m", messages: [{ role: "user", text: "hi" }] }));
});

const at = "2026-10-01T10:00:00.000Z";
export function replayEntries(): ConversationEntry[] {
  let seq = 0;
  const user = (text: string): ConversationEntry => ({ seq: ++seq, at, kind: "user", input: "text", text });
  const bot = (text: string, interrupted = false): ConversationEntry => ({ seq: ++seq, at, kind: "assistant", text, interrupted });
  const tool = (name: string, args: unknown, result?: unknown, truncated = false): ConversationEntry =>
    ({ seq: ++seq, at, kind: "tool", name, args, truncated, ...(result !== undefined ? { result } : {}) }) as ConversationEntry;
  return [
    user("off and Dune"),
    bot("On it."),
    tool("ha_list", {}, { ids: ["light.x"] }),
    tool("ha_turn_off", { entity: "light.x" }, { ok: true }),
    tool("big", { q: "Dune" }, '{"items":[{"name":"Dune (19', true),
    tool("pending", null),
    tool("list", {}, [1, 2]),
    tool("bigargs", '{"text":"xxxx', { ok: true }, true),
    bot("Done, and Dune is", true),
    user("again please"),
    user("hello?"),
    tool("t", {}, { ok: 1 }),
    user("still there?"),
  ];
}

test("golden: a replayed thread", () => {
  golden("history-replay", geminiParams({ model: "m", messages: toMessages(replayEntries()) }).contents);
});

/** The model's first round of the loop case, as Gemini streams it: a bare signature, a thought, text and two calls. */
export const roundParts: Part[] = [
  { thoughtSignature: "sig-0" },
  { text: "thinking", thought: true },
  { text: "Looking.", thoughtSignature: "sig-t" },
  { functionCall: { name: "set_light", args: { entity: "light.x", on: false } }, thoughtSignature: "sig-1" },
  { functionCall: { name: "get_current_time", args: {} } },
];

test("golden: a tool-loop round trip keeps the model's parts and signatures", async () => {
  const responses = roundParts.map((p) => ({ candidates: [{ content: { role: "model", parts: [p] } }] }) as GenerateContentResponse);
  const adapter = new GeminiAdapter("k", undefined, undefined, () => async () => (async function* () { yield* responses; })());
  const first: ChatRequest = { model: "m", system: "sys", messages: [{ role: "user", text: "go" }], tools, thoughts: true };
  const it = adapter.stream(first);
  let r = await it.next();
  while (!r.done) r = await it.next();
  const end: ModelEnd = r.value;
  const results: ChatMessage[] = end.message.toolCalls!.map((c) => ({ role: "tool", callId: c.id, name: c.name, result: { ok: c.name } }));
  golden("loop-round-trip", geminiParams({ ...first, messages: [...first.messages, end.message, ...results] }));
});
