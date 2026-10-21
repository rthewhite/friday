import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_TTL_MS } from "../src/agents/store.js";
import { agentHarness, entries } from "./agent-harness.js";
import { call, text } from "./fake-stream.js";

const PR = { repo: "friday", title: "Bump vite", head: "deps/vite" };

async function parked() {
  const t = agentHarness([
    { chunks: [call("github__list_alerts"), call("github__create_pull_request", PR)] },
    { chunks: [text("One dependency alert; a pull request is queued for your approval.")] },
  ]);
  t.tool("github__list_alerts", () => ({ alerts: 1 }));
  t.tool("github__create_pull_request", (args) => ({ url: `https://github.example/${args.repo}/pull/7` }), ["agent"]);
  t.define({ name: "security-sweep", tools: [{ pattern: "github__*", mode: "auto" }, { pattern: "github__create_pull_request", mode: "approve" }] });
  const r = t.runtime.start("security-sweep", "schedule");
  if (!r.ok) throw new Error("not started");
  const run = await r.done;
  const [action] = t.runs.actions(run.id);
  return { t, run, action };
}

test("an approve tool is parked as the exact call; the model is told it is queued and the run continues", async () => {
  const { t, run, action } = await parked();
  assert.deepEqual(t.calls.map((c) => c.name), ["github__list_alerts"], "the pull request was not created");
  assert.deepEqual([action.tool, action.args, action.state, action.agent], ["github__create_pull_request", PR, "pending", "security-sweep"]);
  assert.deepEqual([run.outcome, run.toolCalls], ["ok", 2], "parked calls count as tool calls");
  const queued = { queued: true, actionId: action.id, note: "Queued for the user's approval. It has not run; continue without its result." };
  assert.deepEqual(t.stream.requests[1].contents.at(-1)!.parts![1], { functionResponse: { name: "github__create_pull_request", response: queued } });
  assert.deepEqual((entries(t.conversations, run.conversationId!)[2] as { result: unknown }).result, queued);
  assert.equal(t.runs.pendingCount("security-sweep"), 1);
});

test("approving runs exactly the stored call once, in the agent channel with the run's conversation", async () => {
  const { t, run, action } = await parked();
  t.clock.advance(24 * 60 * 60 * 1000);
  const r = await t.runtime.approve(action.id);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.status === "ok" && [r.action.state, r.action.result], ["executed", { url: "https://github.example/friday/pull/7" }]);
  assert.deepEqual(t.calls.at(-1), { name: "github__create_pull_request", args: PR, call: { channel: "agent", conversationId: run.conversationId! } });
  assert.equal(t.runs.pendingCount("security-sweep"), 0);

  assert.deepEqual(await t.runtime.approve(action.id), { status: "conflict" });
  assert.deepEqual(t.runtime.reject(action.id), { status: "conflict" });
  assert.equal(t.calls.filter((c) => c.name === "github__create_pull_request").length, 1);
});

test("two approvals at once call the tool once; approving after a rejection is refused", async () => {
  const { t, action } = await parked();
  const [a, b] = await Promise.all([t.runtime.approve(action.id), t.runtime.approve(action.id)]);
  assert.deepEqual([a.status, b.status].sort(), ["conflict", "ok"]);
  assert.equal(t.calls.filter((c) => c.name === "github__create_pull_request").length, 1);

  const second = await parked();
  assert.equal(second.t.runtime.reject(second.action.id).status, "ok");
  assert.deepEqual(await second.t.runtime.approve(second.action.id), { status: "conflict" });
  assert.equal(second.t.calls.filter((c) => c.name === "github__create_pull_request").length, 0);
});

test("approving after the tool's server went away fails the action with a clear error", async () => {
  const { t, action } = await parked();
  t.registry.removeOwner("mcp:github");
  const r = await t.runtime.approve(action.id);
  assert.deepEqual(r.status === "ok" && [r.action.state, r.action.error], ["failed", "tool github__create_pull_request is not available"]);
});

test("a tool that answers with an error fails the action and keeps its result", async () => {
  const { t, action } = await parked();
  t.registry.remove("github__create_pull_request");
  t.tool("github__create_pull_request", () => ({ error: "branch deps/vite does not exist" }), ["agent"]);
  const r = await t.runtime.approve(action.id);
  assert.deepEqual(r.status === "ok" && [r.action.state, r.action.error, r.action.result], ["failed", "branch deps/vite does not exist", { error: "branch deps/vite does not exist" }]);
});

test("approving while the agent is deleted answers missing instead of failing", async () => {
  const { t, action } = await parked();
  let release!: () => void;
  t.registry.remove("github__create_pull_request");
  t.tool("github__create_pull_request", () => new Promise((r) => (release = () => r({ url: "pr/8" }))), ["agent"]);
  const approval = t.runtime.approve(action.id);
  await new Promise((r) => setTimeout(r, 5));
  t.agents.delete("security-sweep");
  release();
  assert.deepEqual(await approval, { status: "missing" });
});

test("a pending action older than 7 days expires and can no longer be approved", async () => {
  const { t, action } = await parked();
  t.clock.advance(ACTION_TTL_MS + 1000);
  assert.deepEqual(await t.runtime.approve(action.id), { status: "expired" });
  assert.equal(t.runs.action(action.id)!.state, "expired");
  assert.deepEqual(await t.runtime.approve("no-such-action"), { status: "missing" });
});
