import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTriggers } from "../src/agents/triggers.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { JobStore } from "../src/jobs/store.js";
import { agentHarness, quiet } from "./agent-harness.js";
import { FakeClock } from "./fake-clock.js";
import { call, text } from "./fake-stream.js";

const PR = { repo: "friday", title: "Bump vite" };
const sanne = { id: "u2", name: "Sanne" };
const owner = { id: "u1", name: "Owner" };

/** An agent that calls an auto tool and parks an approve tool, with two users in the database. */
function harness() {
  const t = agentHarness([{ chunks: [call("github__list_alerts"), call("github__create_pull_request", PR)] }, { chunks: [text("done")] }]);
  t.db.exec(`
    INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u1', 'i', 's1', 'Owner', 'admin', 't', 't');
    INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u2', 'i', 's2', 'Sanne', 'member', 't', 't');
  `);
  t.tool("github__list_alerts", () => ({ alerts: 1 }));
  t.tool("github__create_pull_request", () => ({ url: "https://github.example/pull/7" }), ["agent"]);
  t.define({ name: "security-sweep", tools: [{ pattern: "github__*", mode: "auto" }, { pattern: "github__create_pull_request", mode: "approve" }] });
  return t;
}

test("a run started by a user records them, its conversation is theirs, and its tool calls carry them", async () => {
  const t = harness();
  const r = t.runtime.start("security-sweep", "portal", undefined, sanne);
  assert.ok(r.ok);
  const run = await r.done;
  assert.deepEqual(t.runs.get(run.id)?.user, sanne);
  assert.deepEqual(t.runs.list("security-sweep")[0].user, sanne);
  assert.deepEqual(t.calls.map((c) => c.call), [{ channel: "agent", conversationId: run.conversationId, user: sanne }]);
  assert.deepEqual(t.conversations.usersOf([run.conversationId!]).get(run.conversationId!), sanne);
});

test("a scheduled run has no user, and neither do its calls or conversation", async () => {
  const t = harness();
  const r = t.runtime.start("security-sweep", "schedule");
  assert.ok(r.ok);
  const run = await r.done;
  assert.equal(t.runs.get(run.id)?.user, null);
  assert.deepEqual(t.calls.map((c) => c.call), [{ channel: "agent", conversationId: run.conversationId }]);
  assert.equal(t.conversations.usersOf([run.conversationId!]).get(run.conversationId!), null);
});

test("approving records who decided; the approved call is for the user who started the run", async () => {
  const t = harness();
  const r = t.runtime.start("security-sweep", "portal", undefined, sanne);
  assert.ok(r.ok);
  const run = await r.done;
  const [action] = t.runs.actions(run.id);
  assert.equal(action.decidedBy, null, "pending");
  const approved = await t.runtime.approve(action.id, owner);
  assert.ok(approved.status === "ok");
  assert.deepEqual(approved.action.decidedBy, owner);
  assert.deepEqual(t.calls.at(-1)?.call, { channel: "agent", conversationId: run.conversationId, user: sanne });
});

test("run_agent from chat starts the run for the chat user; from a voice device for nobody", async () => {
  const t = agentHarness([{ chunks: [text("ok")] }]);
  t.db.exec("INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u2', 'i', 's2', 'Sanne', 'member', 't', 't')");
  t.define({ startable: true });
  const jobs = new JobStore(t.db);
  const scheduler = new Scheduler({ store: jobs, clock: new FakeClock(Date.parse("2026-10-25T12:00:00Z")), log: quiet, timezone: "Europe/Amsterdam" });
  new AgentTriggers({ agents: t.agents, runtime: t.runtime, registry: t.registry, scheduler, jobs, timezone: () => "Europe/Amsterdam", log: quiet }).start();

  await t.registry.callTool("run_agent", { agent: "weekly-review" }, { channel: "chat", user: sanne });
  await t.runtime.stop();
  await t.registry.callTool("run_agent", { agent: "weekly-review" }, { channel: "voice", device: "friday-kitchen" });
  await t.runtime.stop();
  const runs = t.runs.list("weekly-review").reverse();
  assert.deepEqual(runs.map((r) => [r.trigger, r.user]), [["chat", sanne], ["voice", null]]);
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
