import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError } from "@friday/sdk";
import { runToolLoop, unfinished, type LoopCall, type ToolLoopOptions } from "../src/llm/tool-loop.js";
import type { ChatMessage } from "../src/llm/types.js";
import { call, fakeStream, text, thought, type Round } from "./fake-stream.js";

function loop(rounds: Round[], o: Partial<ToolLoopOptions> = {}) {
  const f = fakeStream(...rounds);
  const ran: LoopCall[] = [];
  const messages: ChatMessage[] = [{ role: "user", text: "go" }];
  const run = runToolLoop({
    llm: f.llm,
    owner: "agent:test",
    model: "m",
    system: "sys",
    messages,
    tools: [{ name: "a", description: "A." }, { name: "b", description: "B." }],
    callTool: async (c) => (ran.push(c), { ok: c.name }),
    ...o,
  });
  return { ...f, ran, messages, run };
}

test("rounds run until an answer without calls; the model's turn goes back as returned, thoughts don't, tokens add up", async () => {
  const t = loop([
    { chunks: [thought("thinking"), text("Looking."), call("a", { x: 1 }, "p-1"), call("b")], tokens: { input: 100, output: 20 } },
    { chunks: [text("Done: "), text("all good.")], tokens: { input: 150, output: 10 } },
  ]);
  const { outcome, state } = await t.run;
  assert.deepEqual(outcome, { kind: "done", text: "Done: all good." });
  assert.deepEqual(state, { rounds: 1, calls: 2, tokens: 280, streamed: true });
  assert.deepEqual(t.ran.map((c) => [c.id, c.callId, c.name]), [[1, "p-1", "a"], [2, "c2", "b"]]);
  assert.deepEqual(t.owners, ["agent:test", "agent:test"]);
  assert.deepEqual(t.requests[1].messages.slice(1), [
    { role: "assistant", text: "Looking.", toolCalls: [{ id: "p-1", name: "a", args: { x: 1 } }, { id: "c2", name: "b", args: {} }] },
    { role: "tool", callId: "p-1", name: "a", result: { ok: "a" } },
    { role: "tool", callId: "c2", name: "b", result: { ok: "b" } },
  ]);
});

test("parallel calls in one round get different ids, and each result goes back with the id of its call", async () => {
  const t = loop(
    [{ chunks: [call("ha_turn_off", { entity: "light.x" }), call("jellyfin_search", { q: "Dune" })] }, { chunks: [text("Done.")] }],
    // The second call settles first: results still pair with their own calls.
    { callTool: async (c) => (c.name === "ha_turn_off" && (await new Promise((r) => setTimeout(r, 10))), { ok: c.name }) },
  );
  await t.run;
  const [assistant, ...results] = t.requests[1].messages.slice(1) as [Extract<ChatMessage, { role: "assistant" }>, ...Extract<ChatMessage, { role: "tool" }>[]];
  const ids = assistant.toolCalls!.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(results.map((r) => [r.callId, r.name, r.result]), [
    [ids[0], "ha_turn_off", { ok: "ha_turn_off" }],
    [ids[1], "jellyfin_search", { ok: "jellyfin_search" }],
  ]);
});

test("beforeCalls stops the loop before any of the round's calls run", async () => {
  const t = loop([{ chunks: [call("a")] }, { chunks: [call("a"), call("b")] }], {
    beforeCalls: (calls, s) => (s.calls + calls.length > 2 ? { kind: "budget", message: "tool call budget (2) used" } : undefined),
  });
  const { outcome, state } = await t.run;
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(outcome.kind === "stopped" && outcome.unrun.map((c) => [c.id, c.name]), [[2, "a"], [3, "b"]]);
  assert.deepEqual(outcome.kind === "stopped" && outcome.stop, { kind: "budget", message: "tool call budget (2) used" });
  assert.deepEqual(t.ran.map((c) => c.id), [1]);
  assert.equal(state.calls, 1);
});

test("beforeRound stops the loop before the next model call", async () => {
  const t = loop([{ chunks: [call("a")], tokens: { input: 900, output: 200 } }, { chunks: [text("never")] }], {
    beforeRound: (s) => (s.tokens > 1000 ? { kind: "tokens", message: "token budget used" } : undefined),
  });
  const { outcome } = await t.run;
  assert.deepEqual(outcome, { kind: "stopped", stop: { kind: "tokens", message: "token budget used" }, unrun: [] });
  assert.equal(t.requests.length, 1);
});

test("an abort during a model call ends the loop as aborted, and aborting before a round makes no call", async () => {
  const controller = new AbortController();
  const t = loop([{ waitMs: Infinity }], { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  assert.deepEqual((await t.run).outcome, { kind: "aborted" });

  const aborted = new AbortController();
  aborted.abort();
  const u = loop([{ chunks: [text("never")] }], { signal: aborted.signal });
  assert.deepEqual((await u.run).outcome, { kind: "aborted" });
  assert.equal(u.requests.length, 0);
});

test("model failures and unfinished rounds are reported, with whether text was streamed", async () => {
  const failed = loop([{ chunks: [text("Partial")], error: new LlmError("unavailable", "quota") }]);
  const f = await failed.run;
  assert.equal(f.outcome.kind, "failed");
  assert.equal(f.outcome.kind === "failed" && f.outcome.error.kind, "unavailable");
  assert.equal(f.state.streamed, true);

  const cut = loop([{ chunks: [text("Half an ans")], finish: "length" }]);
  const c = await cut.run;
  assert.deepEqual(c.outcome, { kind: "unfinished", message: "the answer was cut off at the output limit" });
  assert.equal(c.state.streamed, true);

  const malformed = loop([{ finish: "malformed_call", providerReason: "MALFORMED_FUNCTION_CALL" }]);
  assert.deepEqual((await malformed.run).outcome, { kind: "unfinished", message: "the model produced a malformed tool call" });
});

test("unfinished names the provider's reason for anything else", () => {
  assert.equal(unfinished("other", "LANGUAGE"), "the model stopped without finishing (LANGUAGE)");
  assert.equal(unfinished("other"), "the model stopped without finishing (unknown reason)");
});

test("around wraps every model call, so a caller can hold a gate", async () => {
  const events: string[] = [];
  const t = loop([{ chunks: [call("a")] }, { chunks: [text("ok")] }], {
    around: async (fn) => {
      events.push("acquire");
      try {
        return await fn();
      } finally {
        events.push("release");
      }
    },
    callTool: async () => (events.push("tool"), {}),
  });
  await t.run;
  assert.deepEqual(events, ["acquire", "release", "tool", "acquire", "release"]);
});
