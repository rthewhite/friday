/**
 * Live checks against the real chat model (skipped unless FRIDAY_LIVE_TESTS=1 and GEMINI_API_KEY).
 * They pin down how Gemini treats chat history: replayed function calls from earlier turns carry no
 * thought signature (we don't store them), while calls within the running turn are sent back verbatim.
 */
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { chatSettings } from "../src/config.js";
import { GeminiTextModel, type StreamChunk } from "../src/llm/gemini.js";

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

/** A previous turn as the store replays it: the call has no thought signature. */
const pastTurn = (signature?: string): Content[] => [
  { role: "user", parts: [{ text: "Is the living room light on?" }] },
  { role: "model", parts: [{ functionCall: { name: "ha_get_state", args: { entity: "light.living_room" } }, ...(signature ? { thoughtSignature: signature } : {}) }] },
  { role: "user", parts: [{ functionResponse: { name: "ha_get_state", response: { state: "on" } } }] },
  { role: "model", parts: [{ text: "Yes, the living room light is on." }] },
];

async function run(contents: Content[]) {
  const model = new GeminiTextModel(process.env.GEMINI_API_KEY!);
  const chunks: StreamChunk[] = [];
  const it = model.stream({ model: chatModel, system: "You are Friday, a home assistant. Use tools.", contents, tools, thoughts: true });
  let r = await it.next();
  while (!r.done) {
    chunks.push(r.value);
    r = await it.next();
  }
  return { chunks, end: r.value };
}

test("live: a replayed unsigned function call from an earlier turn is accepted", { skip }, async () => {
  const { chunks, end } = await run([...pastTurn(), { role: "user", parts: [{ text: "What did you find when you checked it? Answer without tools." }] }]);
  console.log(`model ${end.model}: ${chunks.filter((c) => c.kind === "text").length} text chunks, finish ${end.finishReason}`);
  assert.ok(chunks.some((c) => c.kind === "text" || c.kind === "call"));
});

test("live: within the turn, the model's parts sent back verbatim with the response are accepted", { skip }, async () => {
  const first = await run([...pastTurn(), { role: "user", parts: [{ text: "Turn it off please." }] }]);
  const calls = first.chunks.filter((c) => c.kind === "call");
  console.log(`first round: ${calls.map((c) => c.kind === "call" && c.name).join(", ")}; signed: ${calls.some((c) => !!c.part.thoughtSignature)}`);
  assert.ok(calls.length > 0, "the model calls a tool");
  const modelTurn: Content = { role: "model", parts: first.chunks.filter((c) => c.kind !== "thought").map((c) => c.part) };
  const responses: Part[] = calls.map((c) => ({ functionResponse: { name: c.kind === "call" ? c.name : "", response: { ok: true } } }));
  const second = await run([...pastTurn(), { role: "user", parts: [{ text: "Turn it off please." }] }, modelTurn, { role: "user", parts: responses }]);
  console.log(`second round: finish ${second.end.finishReason}`);
  assert.ok(second.chunks.some((c) => c.kind === "text"));
});
