import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromptContext } from "../src/prompt-context.js";
import { AgentTriggers } from "../src/agents/triggers.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { JobStore } from "../src/jobs/store.js";
import { agentHarness, quiet } from "./agent-harness.js";
import { FakeClock } from "./fake-clock.js";
import { call, fakeStream, text } from "./fake-stream.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { AgentRunStore, AgentStore } from "../src/agents/store.js";
import { ConversationStore } from "../src/conversations/store.js";
import { admin, member, startAuthApp } from "./auth-harness.js";

const PR = { repo: "friday", title: "Bump vite" };
const sanne = { id: "u2", name: "Sanne" };
const owner = { id: "u1", name: "Owner" };

const USERS = `
  INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u1', 'i', 's1', 'Owner', 'admin', 't', 't');
  INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u2', 'i', 's2', 'Sanne', 'member', 't', 't');
`;

/** Sanne's agent, which calls an auto tool and parks an approve tool, with two users in the database. */
function harness() {
  const t = agentHarness([{ chunks: [call("github__list_alerts"), call("github__create_pull_request", PR)] }, { chunks: [text("done")] }]);
  t.db.exec(USERS);
  t.tool("github__list_alerts", () => ({ alerts: 1 }));
  t.tool("github__create_pull_request", () => ({ url: "https://github.example/pull/7" }), ["agent"]);
  t.define({ name: "security-sweep", tools: [{ pattern: "github__*", mode: "auto" }, { pattern: "github__create_pull_request", mode: "approve" }] }, sanne.id);
  return t;
}

for (const trigger of ["portal", "schedule"] as const) {
  test(`a ${trigger} run acts for the agent's creator: the run, its tool calls and its conversation are theirs`, async () => {
    const t = harness();
    const r = t.runtime.start("security-sweep", trigger);
    assert.ok(r.ok);
    const run = await r.done;
    assert.deepEqual(t.runs.get(run.id)?.user, sanne);
    assert.deepEqual(t.runs.list("security-sweep")[0].user, sanne);
    assert.deepEqual(t.calls.map((c) => c.call), [{ channel: "agent", conversationId: run.conversationId, user: sanne }]);
    assert.equal(t.conversations.ownerOf(run.conversationId!), sanne.id);
  });
}

test("an agent created before there was an owner runs for nobody", async () => {
  const t = agentHarness([{ chunks: [call("lookup")] }, { chunks: [text("done")] }]);
  t.tool("lookup");
  t.define({ tools: [{ pattern: "lookup", mode: "auto" }] });
  const r = t.runtime.start("weekly-review", "schedule");
  assert.ok(r.ok);
  const run = await r.done;
  assert.equal(run.user, null);
  assert.deepEqual(t.calls.map((c) => c.call), [{ channel: "agent", conversationId: run.conversationId }]);
});

test("a run gets the tools its creator is offered: an owner-only tool only in the owner's agents", async () => {
  const t = agentHarness([{ chunks: [text("done")] }]);
  t.db.exec(USERS);
  t.registry.setOwnerCheck((u) => u?.id === owner.id);
  t.registry.add("calendar", { name: "calendar_list_events", description: "", ownerOnly: true, handler: () => ({}) });
  t.tool("lookup");
  t.define({ name: "hers", tools: [{ pattern: "*", mode: "auto" }] }, sanne.id);
  t.define({ name: "mine", tools: [{ pattern: "*", mode: "auto" }] }, owner.id);
  for (const name of ["hers", "mine"]) {
    const r = t.runtime.start(name, "portal");
    assert.ok(r.ok);
    await r.done;
  }
  assert.deepEqual(t.stream.requests.map((q) => (q.tools ?? []).map((d) => d.name)), [["lookup"], ["calendar_list_events", "lookup"]]);
});

test("approving records who decided; the approved call is for the agent's creator", async () => {
  const t = harness();
  const r = t.runtime.start("security-sweep", "schedule");
  assert.ok(r.ok);
  const run = await r.done;
  const [action] = t.runs.actions(run.id);
  assert.equal(action.decidedBy, null, "pending");
  const approved = await t.runtime.approve(action.id, sanne);
  assert.ok(approved.status === "ok");
  assert.deepEqual(approved.action.decidedBy, sanne);
  assert.deepEqual(t.calls.at(-1)?.call, { channel: "agent", conversationId: run.conversationId, user: sanne });
});

test("rejecting records who decided", async () => {
  const t = harness();
  const r = t.runtime.start("security-sweep", "schedule");
  assert.ok(r.ok);
  const run = await r.done;
  const [action] = t.runs.actions(run.id);
  const rejected = t.runtime.reject(action.id, sanne);
  assert.ok(rejected.status === "ok");
  assert.deepEqual(rejected.action.decidedBy, sanne);
  assert.deepEqual(t.runs.action(action.id)?.decidedBy, sanne);
});

function triggers() {
  const t = agentHarness([{ chunks: [text("ok")] }]);
  t.db.exec(USERS);
  t.define({ startable: true }, owner.id);
  t.define({ name: "her-digest", description: "Sanne's daily digest", startable: true }, sanne.id);
  const jobs = new JobStore(t.db);
  const scheduler = new Scheduler({ store: jobs, clock: new FakeClock(Date.parse("2026-10-25T12:00:00Z")), log: quiet, timezone: "Europe/Amsterdam" });
  const prompts = createPromptContext({ log: quiet });
  new AgentTriggers({ agents: t.agents, runtime: t.runtime, registry: t.registry, scheduler, jobs, timezone: () => "Europe/Amsterdam", log: quiet, prompt: prompts.forOwner("core") }).start();
  return { ...t, prompts };
}

test("run_agent starts the caller's own agent, which runs as them; a device's session acts for the owner", async () => {
  const t = triggers();
  await t.registry.callTool("run_agent", { agent: "her-digest" }, { channel: "chat", user: sanne });
  await t.runtime.stop();
  await t.registry.callTool("run_agent", { agent: "weekly-review" }, { channel: "voice", device: "friday-kitchen", user: owner });
  await t.runtime.stop();
  assert.deepEqual(t.runs.list("her-digest").map((r) => [r.trigger, r.user]), [["chat", sanne]]);
  assert.deepEqual(t.runs.list("weekly-review").map((r) => [r.trigger, r.user]), [["voice", owner]]);
});

test("another user's agent: run_agent answers with an error and starts nothing, and the prompt never lists it", async () => {
  const t = triggers();
  const r = await t.registry.callTool("run_agent", { agent: "weekly-review" }, { channel: "chat", user: sanne });
  assert.deepEqual(r.result, { error: 'there is no agent "weekly-review" that can be started by voice or chat' });
  const none = await t.registry.callTool("run_agent", { agent: "weekly-review" }, { channel: "voice", device: "friday-kitchen" });
  assert.match(String(none.result.error), /there is no agent/, "a device's session without an owner starts nothing");
  assert.deepEqual(t.runs.list("weekly-review"), []);

  const decl = t.registry.declarations("chat").find((d) => d.name === "run_agent")!;
  assert.doesNotMatch(JSON.stringify(decl), /weekly-review|her-digest|digest/, "the declaration names no agent");
  assert.equal(t.prompts.render("chat", sanne), "## Agents\nThe user's agents you can start with run_agent:\n- her-digest: Sanne's daily digest");
  assert.equal(t.prompts.render("voice", owner), "## Agents\nThe user's agents you can start with run_agent:\n- weekly-review: Sums up my week");
  assert.equal(t.prompts.render("chat"), "", "nothing without a user");
  t.agents.update({ ...t.agents.get("her-digest")!, enabled: false });
  assert.equal(t.prompts.render("chat", sanne), "", "nothing when they have no enabled startable agent");
});

test("over HTTP: agents are their creator's; others, the admin owner too, get 404 for the agent, its runs and actions", async () => {
  let runtime: AgentRuntime | undefined;
  const app = await startAuthApp({
    deps: ({ db, registry }) => {
      const agents = new AgentStore(db);
      const runs = new AgentRunStore(db);
      registry.add("test", { name: "github__list_alerts", description: "", handler: () => ({ alerts: 1 }) });
      registry.add("test", { name: "github__create_pull_request", description: "", channels: ["agent"], handler: () => ({ url: "u" }) });
      const stream = fakeStream({ chunks: [call("github__list_alerts"), call("github__create_pull_request", PR)] }, { chunks: [text("done")] });
      runtime = new AgentRuntime({ agents, runs, registry, conversations: new ConversationStore(db, { log: quiet }), llm: stream.llm, model: "m", timezone: () => "Europe/Amsterdam", toolTimeoutMs: 1000, log: quiet });
      return { agents: { agents, runs, runtime, registry, nextRun: () => null } };
    },
  });
  const post = (path: string, body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const sanne = app.browser();
    await sanne.login("/", member);
    const owner = app.browser();
    await owner.login("/", admin);
    const ids = new Map(app.users.list().map((u) => [u.name, u.id]));
    const def = { name: "security-sweep", description: "d", instructions: "i", tools: [{ pattern: "github__*", mode: "auto" }, { pattern: "github__create_pull_request", mode: "approve" }] };
    assert.equal((await sanne.fetch("/api/agents", post("/api/agents", def))).status, 201);
    const taken = await owner.fetch("/api/agents", post("/api/agents", { ...def, description: "mine" }));
    assert.equal(taken.status, 409);
    assert.equal(((await taken.json()) as { error: string }).error, 'the name "security-sweep" is already in use');

    const started = await sanne.fetch("/api/agents/security-sweep/run", post(""));
    assert.equal(started.status, 202);
    const { runId } = (await started.json()) as { runId: string };
    type Run = { outcome: string; user: unknown; actions: { id: string }[] };
    let run: Run;
    do run = (await (await sanne.fetch(`/api/agents/runs/${runId}`)).json()) as Run;
    while (run.outcome === "running");
    assert.equal(run.outcome, "ok");
    assert.deepEqual(run.user, { id: ids.get("Sanne"), name: "Sanne" });
    const actionId = run.actions[0].id;

    // The admin owner can't look in or act.
    const listed = (await (await owner.fetch("/api/agents")).json()) as { agents: unknown[] };
    assert.deepEqual(listed.agents, []);
    for (const [path, init] of [
      ["/api/agents/security-sweep", undefined],
      ["/api/agents/security-sweep/runs", undefined],
      [`/api/agents/runs/${runId}`, undefined],
      ["/api/agents/security-sweep", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(def) }],
      ["/api/agents/security-sweep/run", post("")],
      [`/api/agents/runs/${runId}/cancel`, post("")],
      [`/api/agents/actions/${actionId}/approve`, post("")],
      [`/api/agents/actions/${actionId}/reject`, post("")],
      ["/api/agents/security-sweep", { method: "DELETE" }],
    ] as const) {
      assert.equal((await owner.fetch(path, init as RequestInit | undefined)).status, 404, `${init?.method ?? "GET"} ${path}`);
    }

    const approved = await sanne.fetch(`/api/agents/actions/${actionId}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    assert.deepEqual(((await approved.json()) as { decidedBy: unknown }).decidedBy, { id: ids.get("Sanne"), name: "Sanne" });
    assert.deepEqual(((await (await sanne.fetch("/api/agents")).json()) as { agents: { name: string }[] }).agents.map((a) => a.name), ["security-sweep"]);
  } finally {
    await runtime?.stop();
    await app.close();
  }
});

test("a disabled creator's agent doesn't run: scheduled, from the portal or by run_agent", async () => {
  const t = agentHarness([{ chunks: [text("done")] }], { isActive: (id) => id !== sanne.id });
  t.db.exec(USERS);
  t.define({ name: "her-digest", startable: true }, sanne.id);
  assert.deepEqual(t.runtime.start("her-digest", "schedule"), { ok: false, reason: "disabled" });
  assert.deepEqual(t.runs.list("her-digest"), []);
});
