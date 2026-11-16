/** Stored chat entries as provider-neutral messages (how Gemini merges them is checked in llm-golden.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationEntry } from "@friday/sdk";
import { toMessages } from "../src/chat/history.js";

const at = "2026-10-01T10:00:00.000Z";
let seq = 0;
const user = (text: string, input: "text" | "speech" = "text"): ConversationEntry => ({ seq: ++seq, at, kind: "user", input, text });
const bot = (text: string, interrupted = false): ConversationEntry => ({ seq: ++seq, at, kind: "assistant", text, interrupted });
const tool = (name: string, args: unknown, result?: unknown, truncated = false): ConversationEntry =>
  ({ seq: ++seq, at, kind: "tool", name, args, truncated, ...(result !== undefined ? { result } : {}) }) as ConversationEntry;

test("user and assistant entries become user and assistant text, interrupted answers as stored", () => {
  assert.deepEqual(toMessages([user("hello"), bot("Hi!"), user("tell me about Dune"), bot("Dune is", true)]), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "Hi!" },
    { role: "user", text: "tell me about Dune" },
    { role: "assistant", text: "Dune is" },
  ]);
  assert.deepEqual(toMessages([]), []);
});

test("replayed thread gets call ids: each stored call gets its own id, followed by its result", () => {
  seq = 0;
  assert.deepEqual(toMessages([user("off and Dune"), tool("ha_turn_off", { entity: "light.x" }, { ok: true }), tool("jellyfin_search", { q: "Dune" }, { items: 1 }), bot("Done.")]), [
    { role: "user", text: "off and Dune" },
    { role: "assistant", toolCalls: [{ id: "h2", name: "ha_turn_off", args: { entity: "light.x" } }] },
    { role: "tool", callId: "h2", name: "ha_turn_off", result: { ok: true } },
    { role: "assistant", toolCalls: [{ id: "h3", name: "jellyfin_search", args: { q: "Dune" } }] },
    { role: "tool", callId: "h3", name: "jellyfin_search", result: { items: 1 } },
    { role: "assistant", text: "Done." },
  ]);
});

test("an assistant's text and the call right after it are one assistant turn, so roles alternate", () => {
  seq = 0;
  assert.deepEqual(toMessages([user("off and Dune"), bot("On it."), tool("ha_list", {}, { ids: ["light.x"] }), tool("ha_turn_off", { entity: "light.x" }, { ok: true }), bot("Done.")]), [
    { role: "user", text: "off and Dune" },
    { role: "assistant", text: "On it.", toolCalls: [{ id: "h3", name: "ha_list", args: {} }] },
    { role: "tool", callId: "h3", name: "ha_list", result: { ids: ["light.x"] } },
    { role: "assistant", toolCalls: [{ id: "h4", name: "ha_turn_off", args: { entity: "light.x" } }] },
    { role: "tool", callId: "h4", name: "ha_turn_off", result: { ok: true } },
    { role: "assistant", text: "Done." },
  ]);
});

test("truncated, missing and non-object results and arguments get placeholders", () => {
  const cut = '{"items":[{"name":"Dune (19';
  const messages = toMessages([
    user("search"),
    tool("big", { q: "Dune" }, cut, true),
    tool("pending", null),
    tool("list", {}, [1, 2]),
    tool("bigargs", '{"text":"xxxx', { ok: true }, true),
  ]);
  const results = messages.flatMap((m) => (m.role === "tool" ? [m.result] : []));
  assert.deepEqual(results, [{ truncated: true, partial: cut }, { error: "no result" }, { result: [1, 2] }, { ok: true }]);
  const args = messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls!.map((c) => c.args) : []));
  assert.deepEqual(args, [{ q: "Dune" }, {}, {}, { truncated: true, partial: '{"text":"xxxx' }]);
});

test("ids stay unique within a request even when the store numbers entries far apart", () => {
  const ids = toMessages([tool("a", {}, {}), user("x"), tool("a", {}, {})]).flatMap((m) => (m.role === "tool" ? [m.callId] : []));
  assert.equal(new Set(ids).size, 2);
});
