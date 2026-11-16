/**
 * Golden Gemini requests: what core sent to Gemini before the provider-neutral layer (llm-adapters).
 * Each fixture in test/fixtures/gemini-golden/ holds a case's input and the Gemini parameters or contents
 * it produced; the Gemini adapter must keep producing exactly these. `UPDATE_GOLDEN=1` rewrites them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Content } from "@google/genai";
import { Type, type ConversationEntry } from "@friday/sdk";
import { toContents } from "../src/chat/history.js";
import { toGeminiParams, toStreamParams } from "../src/llm/gemini.js";
import { runToolLoop } from "../src/llm/tool-loop.js";
import { call, fakeStream, text, thought } from "./fake-stream.js";

const dir = new URL("./fixtures/gemini-golden/", import.meta.url);

/** Compares `output` with the stored fixture, or (re)writes it with `UPDATE_GOLDEN=1`. */
function golden(name: string, input: unknown, output: unknown): void {
  const file = new URL(`${name}.json`, dir);
  const actual = JSON.parse(JSON.stringify({ input, output }));
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
  }
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(actual.output, stored.output);
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
  const input = { model: "gemini-flash-latest", system: "Be brief.", prompt: "hi", schema, temperature: 0.2, maxOutputTokens: 100 };
  golden("generate-prompt", input, toGeminiParams(input));
});

test("golden: messages with user and model turns", () => {
  const input = { model: "m", messages: [{ role: "user" as const, text: "a" }, { role: "model" as const, text: "b" }, { role: "user" as const, text: "c" }] };
  golden("generate-messages", input, toGeminiParams(input));
});

test("golden: a streamed request with tools and thoughts", () => {
  const input = { model: "m", system: "sys", contents: [{ role: "user", parts: [{ text: "hi" }] }], tools, thoughts: true };
  golden("stream-tools-thoughts", input, toStreamParams(input));
  const bare = { model: "m", contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  golden("stream-bare", bare, toStreamParams(bare));
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
  const entries = replayEntries();
  golden("history-replay", entries, toContents(entries));
});

test("golden: a tool-loop round trip keeps the model's parts and signatures", async () => {
  const f = fakeStream(
    {
      chunks: [
        { kind: "other", part: { thoughtSignature: "sig-0" } },
        thought("thinking"),
        text("Looking.", { thoughtSignature: "sig-t" }),
        call("set_light", { entity: "light.x", on: false }, "sig-1"),
        call("get_current_time"),
      ],
    },
    { chunks: [text("Done.")] },
  );
  const contents: Content[] = [{ role: "user", parts: [{ text: "go" }] }];
  await runToolLoop({ llm: f.llm, owner: "chat", model: "m", system: "sys", contents, tools, thoughts: true, callTool: async (c) => ({ ok: c.name }) });
  golden("loop-round-trip", { history: [{ role: "user", parts: [{ text: "go" }] }] }, toStreamParams({ ...f.requests[1], tools, thoughts: true }));
});
