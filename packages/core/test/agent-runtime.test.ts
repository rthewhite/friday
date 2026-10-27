import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError } from "@friday/sdk";
import { START_MESSAGE } from "../src/agents/runtime.js";
import type { StreamChunk, StreamEnd, TextModel, TextStream } from "../src/llm/gemini.js";
import { LlmService } from "../src/llm/service.js";
import { agentHarness, entries, quiet } from "./agent-harness.js";
import { call, text } from "./fake-stream.js";
import { waitFor } from "./helpers.js";

const started = (r: ReturnType<ReturnType<typeof agentHarness>["runtime"]["start"]>) => {
  if (!r.ok) throw new Error(`not started: ${r.reason}`);
  return r;
};

test("a scheduled check: the model sees its preamble, instructions and only its tools; the run is ok with the answer as summary", async () => {
  const t = agentHarness([
    { chunks: [call("calendar_list_events", { from: "2026-10-19", to: "2026-10-25" })], tokens: { input: 1000, output: 50 } },
    { chunks: [text("Busy week: 14 meetings, "), text("Thursday is free.")], tokens: { input: 1500, output: 40 } },
  ]);
  t.tool("calendar_list_events", () => ({ events: 14 }));
  t.tool("brain_remember");
  t.tool("set_timer", undefined, ["voice"]);
  t.define({ tools: [{ pattern: "calendar_*", mode: "auto" }, { pattern: "set_timer", mode: "auto" }] });

  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.summary, run.toolCalls, run.tokens, run.error], ["ok", "Busy week: 14 meetings, Thursday is free.", 1, 2590, null]);

  const req = t.stream.requests[0];
  assert.equal(req.model, "text-model");
  assert.equal(req.thoughts, false);
  assert.deepEqual(req.tools!.map((d) => d.name), ["calendar_list_events"]);
  assert.match(req.system!, /^You are "weekly-review", an agent of Friday/);
  assert.ok(req.system!.endsWith("Look at the calendar and sum up my week."));
  assert.deepEqual(req.contents, [{ role: "user", parts: [{ text: START_MESSAGE }] }]);
  assert.deepEqual(t.stream.owners, ["agent:weekly-review", "agent:weekly-review"]);

  assert.deepEqual(t.calls, [{ name: "calendar_list_events", args: { from: "2026-10-19", to: "2026-10-25" }, call: { channel: "agent", conversationId: run.conversationId! } }]);
  const c = t.conversations.get(run.conversationId!)!;
  assert.deepEqual([c.channel, c.state, c.endReason], ["agent", "quiet", "done"]);
  assert.deepEqual(entries(t.conversations, run.conversationId!), [
    { kind: "user", input: "text", text: START_MESSAGE },
    { kind: "tool", name: "calendar_list_events", args: { from: "2026-10-19", to: "2026-10-25" }, result: { events: 14 }, truncated: false },
    { kind: "assistant", text: "Busy week: 14 meetings, Thursday is free.", interrupted: false },
  ]);
  assert.equal(t.runtime.running("weekly-review"), undefined);
});

test("a call outside the agent's tools is refused without running the handler, and the run continues", async () => {
  const t = agentHarness([{ chunks: [call("brain_remember", { entity: "me", fact: "x" })] }, { chunks: [text("Done.")] }]);
  t.tool("calendar_list_events");
  t.tool("brain_remember");
  t.define({ tools: [{ pattern: "calendar_*", mode: "auto" }] });
  const run = await started(t.runtime.start("weekly-review", "portal")).done;
  assert.equal(run.outcome, "ok");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(entries(t.conversations, run.conversationId!)[1], {
    kind: "tool", name: "brain_remember", args: { entity: "me", fact: "x" }, result: { error: "tool brain_remember is not available to this agent" }, truncated: false,
  });
});

test("a request is the run's first message and is recorded with its trigger", async () => {
  const t = agentHarness([{ chunks: [text("Only the friday repo: fine.")] }]);
  t.define();
  const run = await started(t.runtime.start("weekly-review", "voice", "  only look at the friday repo ")).done;
  assert.deepEqual([run.trigger, run.request], ["voice", "only look at the friday repo"]);
  assert.deepEqual(t.stream.requests[0].contents, [{ role: "user", parts: [{ text: "only look at the friday repo" }] }]);
  assert.equal(t.conversations.get(run.conversationId!)!.preview, "only look at the friday repo");
});

test("one run per agent: a second start is refused with the running run's start time; unknown agents are refused", async () => {
  const t = agentHarness([{ waitMs: 20, chunks: [text("ok")] }]);
  t.define();
  const first = started(t.runtime.start("weekly-review", "schedule"));
  const second = t.runtime.start("weekly-review", "portal");
  assert.deepEqual(second, { ok: false, reason: "busy", since: first.run.startedAt, runId: first.run.id });
  assert.equal(t.runtime.running("weekly-review")!.id, first.run.id);
  assert.deepEqual(t.runtime.start("nobody", "portal"), { ok: false, reason: "unknown" });
  await first.done;
  assert.equal(t.runtime.start("weekly-review", "portal").ok, true);
});

test("cancelling stops the model call in flight and records the run as cancelled", async () => {
  const t = agentHarness([{ waitMs: Infinity }]);
  t.define();
  const r = started(t.runtime.start("weekly-review", "portal"));
  await waitFor(() => t.stream.requests.length === 1);
  assert.equal(t.runtime.cancel(r.run.id), true);
  const run = await r.done;
  assert.equal(run.outcome, "cancelled");
  assert.equal(t.conversations.get(run.conversationId!)!.endReason, "cancelled");
  assert.equal(t.runtime.cancel(r.run.id), false);
});

test("a model that is unavailable fails the run with the error and keeps what was recorded", async () => {
  const t = agentHarness([{ chunks: [call("calendar_list_events")] }, { chunks: [text("Half")], error: new LlmError("unavailable", "rate limited: daily quota exhausted") }]);
  t.tool("calendar_list_events");
  t.define({ tools: [{ pattern: "calendar_*", mode: "auto" }] });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.error], ["failed", "unavailable: rate limited: daily quota exhausted"]);
  assert.deepEqual(entries(t.conversations, run.conversationId!).map((e) => e.kind), ["user", "tool", "assistant"]);
  assert.equal((entries(t.conversations, run.conversationId!)[2] as { interrupted: boolean }).interrupted, true);
});

test("a stored definition that no longer validates fails the run before any model call", async () => {
  const t = agentHarness([{ chunks: [text("never")] }]);
  t.define();
  t.db.prepare("UPDATE agents SET budgets_json = ? WHERE name = ?").run(JSON.stringify({ maxMinutes: 500 }), "weekly-review");
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.equal(run.outcome, "failed");
  assert.match(run.error!, /^invalid definition: maxMinutes/);
  assert.equal(t.stream.requests.length, 0);
});

// ---- budgets ----

test("tool call budget: a round that would cross it is not run, its calls are recorded with an error", async () => {
  const t = agentHarness([
    { chunks: [call("calendar_list_events", { n: 1 }), call("calendar_list_events", { n: 2 })] },
    { chunks: [call("calendar_list_events", { n: 3 }), call("calendar_list_events", { n: 4 })] },
    { chunks: [call("calendar_list_events", { n: 5 }), call("calendar_list_events", { n: 6 }), call("calendar_list_events", { n: 7 })] },
  ]);
  t.tool("calendar_list_events");
  t.define({ tools: [{ pattern: "calendar_*", mode: "auto" }], budgets: { maxToolCalls: 5 } });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.toolCalls, run.summary], ["budget_exceeded", 4, "Stopped: the tool call budget (5) is used up."]);
  assert.deepEqual(t.calls.map((c) => c.args.n), [1, 2, 3, 4]);
  const tail = entries(t.conversations, run.conversationId!).slice(-3);
  assert.deepEqual(tail.map((e) => (e as { result: unknown }).result), Array(3).fill({ error: "not run: the tool call budget (5) is used up" }));
});

test("token budget: once the reported tokens reach it, no further model call is made", async () => {
  const t = agentHarness([{ chunks: [call("calendar_list_events")], tokens: { input: 9000, output: 1500 } }, { chunks: [text("never")] }]);
  t.tool("calendar_list_events");
  t.define({ tools: [{ pattern: "calendar_*", mode: "auto" }], budgets: { maxTokens: 10000 } });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.tokens, run.summary], ["budget_exceeded", 10500, "Stopped: the token budget (10000) is used up."]);
  assert.equal(t.stream.requests.length, 1);
});

test("token budget: the calls of the round that crossed it are not run", async () => {
  const t = agentHarness([{ chunks: [call("github__create_issue", { title: "x" })], tokens: { input: 11_000, output: 500 } }]);
  t.tool("github__create_issue");
  t.define({ tools: [{ pattern: "github__*", mode: "auto" }], budgets: { maxTokens: 10000 } });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.toolCalls, run.summary], ["budget_exceeded", 0, "Stopped: the token budget (10000) is used up."]);
  assert.deepEqual(t.calls, [], "the issue was not created");
  assert.deepEqual((entries(t.conversations, run.conversationId!)[1] as { result: unknown }).result, { error: "not run: the token budget (10000) is used up" });
});

test("time budget: a model call still running when the minutes are up is aborted", async () => {
  const t = agentHarness([{ waitMs: Infinity }], { minuteMs: 10 });
  t.define({ budgets: { maxMinutes: 2 } });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.summary], ["budget_exceeded", "Stopped: the time budget (2 minutes) is used up."]);
});

test("time budget: a tool call still running when the minutes are up is abandoned", async () => {
  const t = agentHarness([{ chunks: [call("slow_tool")] }, { chunks: [text("never")] }], { minuteMs: 10, toolTimeoutMs: 60_000 });
  t.tool("slow_tool", () => new Promise(() => {}));
  t.define({ tools: [{ pattern: "slow_tool", mode: "auto" }], budgets: { maxMinutes: 1 } });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.equal(run.outcome, "budget_exceeded");
  assert.deepEqual((entries(t.conversations, run.conversationId!)[1] as { result: unknown }).result, { error: "not finished: the run was stopped" });
});

test("a tool that never answers is timed out and the run continues", async () => {
  const t = agentHarness([{ chunks: [call("slow_tool")] }, { chunks: [text("Carried on.")] }], { toolTimeoutMs: 10 });
  t.tool("slow_tool", () => new Promise(() => {}));
  t.define({ tools: [{ pattern: "slow_tool", mode: "auto" }] });
  const run = await started(t.runtime.start("weekly-review", "schedule")).done;
  assert.deepEqual([run.outcome, run.summary], ["ok", "Carried on."]);
  assert.deepEqual((entries(t.conversations, run.conversationId!)[1] as { result: unknown }).result, { error: "timed out after 10 ms" });
});

// ---- fairness ----

/** A TextModel whose streams each wait until `release()` is called, then answer. */
function heldModel() {
  const end: StreamEnd = { finishReason: "STOP", model: "m", usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } };
  let open = 0;
  let max = 0;
  const releases: Array<() => void> = [];
  const model: TextModel = {
    generate: async () => ({ text: "", model: "m", finishReason: "STOP", usage: end.usage }),
    stream(): TextStream {
      return (async function* (): AsyncGenerator<StreamChunk, StreamEnd> {
        open++;
        max = Math.max(max, open);
        await new Promise<void>((r) => releases.push(r));
        open--;
        yield text("done");
        return end;
      })();
    },
  };
  return { model, releases, get open() { return open; }, get max() { return max; } };
}

test("two running agents hold one of the two shared slots; a chat call starts at once", async () => {
  const held = heldModel();
  const llm = new LlmService({ model: held.model, models: { standard: "m", fast: "m" }, concurrency: 2, timeoutMs: 10_000, log: quiet });
  const t = agentHarness([], { llm });
  t.define();
  t.define({ name: "security-sweep" });
  const a = started(t.runtime.start("weekly-review", "schedule"));
  const b = started(t.runtime.start("security-sweep", "schedule"));
  await waitFor(() => held.open === 1);
  assert.equal(held.open, 1, "one agent model call in flight, the other waits at the agent gate");

  const chat = llm.streamCall("chat", { model: "m", contents: [{ role: "user", parts: [{ text: "hi" }] }] }, () => {});
  await waitFor(() => held.open === 2);
  assert.equal(held.open, 2, "the chat call took the free slot at once");

  while (held.releases.length) held.releases.shift()!();
  await chat;
  // The second agent gets the gate once the first finishes.
  await waitFor(() => held.releases.length > 0);
  while (held.releases.length) held.releases.shift()!();
  assert.deepEqual([(await a.done).outcome, (await b.done).outcome], ["ok", "ok"]);
  assert.equal(held.max, 2);
});
