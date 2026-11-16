/**
 * Live checks against the real chat model (skipped unless FRIDAY_LIVE_TESTS=1 and GEMINI_API_KEY).
 * They pin down how Gemini treats chat history: replayed function calls from earlier turns carry no
 * thought signature (we don't store them), while the model's turn within the running turn goes back as
 * the Gemini adapter returned it (its parts, signatures included, as provider data).
 */
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FunctionDeclaration } from "@friday/sdk";
import { chatSettings } from "../src/config.js";
import { GeminiAdapter } from "../src/llm/gemini.js";
import type { ChatMessage, StreamChunk } from "../src/llm/types.js";

const live = process.env.FRIDAY_LIVE_TESTS === "1" && !!process.env.GEMINI_API_KEY;
const skip = live ? false : "set FRIDAY_LIVE_TESTS=1 and GEMINI_API_KEY";
const { chatModel } = chatSettings(process.env);

const tools: FunctionDeclaration[] = [
  {
    name: "ha_get_state",
    description: "Get the state of a Home Assistant entity.",
    parametersJsonSchema: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
  },
  {
    name: "ha_turn_off",
    description: "Turn off a Home Assistant entity.",
    parametersJsonSchema: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
  },
];

/** A previous turn as the store replays it: the call has a made-up id and no provider data. */
const pastTurn: ChatMessage[] = [
  { role: "user", text: "Is the living room light on?" },
  { role: "assistant", toolCalls: [{ id: "h2", name: "ha_get_state", args: { entity: "light.living_room" } }] },
  { role: "tool", callId: "h2", name: "ha_get_state", result: { state: "on" } },
  { role: "assistant", text: "Yes, the living room light is on." },
];

async function run(messages: ChatMessage[]) {
  const model = new GeminiAdapter(process.env.GEMINI_API_KEY!);
  const chunks: StreamChunk[] = [];
  const it = model.stream({ model: chatModel, system: "You are Friday, a home assistant. Use tools.", messages, tools, thoughts: true });
  let r = await it.next();
  while (!r.done) {
    chunks.push(r.value);
    r = await it.next();
  }
  return { chunks, end: r.value };
}

test("live: a replayed unsigned function call from an earlier turn is accepted", { skip }, async () => {
  const { chunks, end } = await run([...pastTurn, { role: "user", text: "What did you find when you checked it? Answer without tools." }]);
  console.log(`model ${end.model}: ${chunks.filter((c) => c.kind === "text").length} text chunks, finish ${end.finish}`);
  assert.ok(chunks.some((c) => c.kind === "text" || c.kind === "call"));
});

test("live: within the turn, the model's turn sent back as returned with the results is accepted", { skip }, async () => {
  const ask: ChatMessage[] = [...pastTurn, { role: "user", text: "Turn it off please." }];
  const first = await run(ask);
  const calls = first.end.message.toolCalls ?? [];
  const parts = (first.end.message.providerData?.value ?? []) as Array<{ thoughtSignature?: string }>;
  console.log(`first round: ${calls.map((c) => c.name).join(", ")}; signed: ${parts.some((p) => !!p.thoughtSignature)}`);
  assert.ok(calls.length > 0, "the model calls a tool");
  const results: ChatMessage[] = calls.map((c) => ({ role: "tool", callId: c.id, name: c.name, result: { ok: true } }));
  const second = await run([...ask, first.end.message, ...results]);
  console.log(`second round: finish ${second.end.finish}`);
  assert.ok(second.chunks.some((c) => c.kind === "text"));
});
