import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationEntry } from "@friday/sdk";
import { toContents } from "../src/chat/history.js";

const at = "2026-10-01T10:00:00.000Z";
let seq = 0;
const user = (text: string, input: "text" | "speech" = "text"): ConversationEntry => ({ seq: ++seq, at, kind: "user", input, text });
const bot = (text: string, interrupted = false): ConversationEntry => ({ seq: ++seq, at, kind: "assistant", text, interrupted });
const tool = (name: string, args: unknown, result?: unknown, truncated = false): ConversationEntry =>
  ({ seq: ++seq, at, kind: "tool", name, args, truncated, ...(result !== undefined ? { result } : {}) }) as ConversationEntry;

test("user and assistant entries alternate as user and model text", () => {
  assert.deepEqual(toContents([user("hello"), bot("Hi!"), user("how are you?")]), [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ text: "Hi!" }] },
    { role: "user", parts: [{ text: "how are you?" }] },
  ]);
  assert.deepEqual(toContents([]), []);
});

test("a tool entry is the model's call followed by the function response", () => {
  assert.deepEqual(toContents([user("is the living room light on?"), tool("ha_get_state", { entity: "light.living" }, { state: "on" }), bot("Yes, it is on."), user("turn it off")]), [
    { role: "user", parts: [{ text: "is the living room light on?" }] },
    { role: "model", parts: [{ functionCall: { name: "ha_get_state", args: { entity: "light.living" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "ha_get_state", response: { state: "on" } } }] },
    { role: "model", parts: [{ text: "Yes, it is on." }] },
    { role: "user", parts: [{ text: "turn it off" }] },
  ]);
});

test("text before a call joins its model turn; calls in a row each get their response before the next call", () => {
  assert.deepEqual(toContents([user("off and Dune"), bot("On it."), tool("ha_list", {}, { ids: ["light.x"] }), tool("ha_turn_off", { entity: "light.x" }, { ok: true }), bot("Done.")]), [
    { role: "user", parts: [{ text: "off and Dune" }] },
    { role: "model", parts: [{ text: "On it." }, { functionCall: { name: "ha_list", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "ha_list", response: { ids: ["light.x"] } } }] },
    { role: "model", parts: [{ functionCall: { name: "ha_turn_off", args: { entity: "light.x" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "ha_turn_off", response: { ok: true } } }] },
    { role: "model", parts: [{ text: "Done." }] },
  ]);
});

test("truncated, missing and non-object results and arguments get placeholders", () => {
  const cut = '{"items":[{"name":"Dune (19';
  const contents = toContents([
    user("search"),
    tool("big", { q: "Dune" }, cut, true),
    tool("pending", null),
    tool("list", {}, [1, 2]),
    tool("bigargs", '{"text":"xxxx', { ok: true }, true),
  ]);
  const responses = contents.filter((c) => c.role === "user").slice(1).map((c) => c.parts![0].functionResponse!.response);
  assert.deepEqual(responses, [{ truncated: true, partial: cut }, { error: "no result" }, { result: [1, 2] }, { ok: true }]);
  const args = contents.filter((c) => c.role === "model").map((c) => c.parts![0].functionCall!.args);
  assert.deepEqual(args, [{ q: "Dune" }, {}, {}, { truncated: true, partial: '{"text":"xxxx' }]);
});

test("interrupted answers are replayed as stored; a turn without an answer leaves user turns apart", () => {
  assert.deepEqual(toContents([user("tell me about Dune"), bot("Dune is", true), user("again please"), user("hello?")]), [
    { role: "user", parts: [{ text: "tell me about Dune" }] },
    { role: "model", parts: [{ text: "Dune is" }] },
    { role: "user", parts: [{ text: "again please" }, { text: "hello?" }] },
  ]);
  // A turn that failed after its tools: responses, then the next question in its own user turn.
  assert.deepEqual(toContents([user("q"), tool("t", {}, { ok: 1 }), user("still there?")]).map((c) => c.role), ["user", "model", "user", "user"]);
});
