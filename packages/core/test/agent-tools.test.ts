import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgent } from "../src/agents/definition.js";
import { AgentTriggers, RUN_AGENT } from "../src/agents/triggers.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { JobStore } from "../src/jobs/store.js";
import { agentHarness, quiet } from "./agent-harness.js";
import { FakeClock } from "./fake-clock.js";
import { text, type Round } from "./fake-stream.js";

function setup(rounds: Round[] = [{ chunks: [text("Done.")] }]) {
  const t = agentHarness(rounds);
  const jobs = new JobStore(t.db);
  const scheduler = new Scheduler({ store: jobs, clock: new FakeClock(Date.parse("2026-10-01T10:00:00Z")), log: quiet, timezone: "Europe/Amsterdam" });
  const triggers = new AgentTriggers({ agents: t.agents, runtime: t.runtime, registry: t.registry, scheduler, jobs, timezone: () => "Europe/Amsterdam", log: quiet });
  const save = (name: string, extra: Record<string, unknown> = {}) => {
    const def = parseAgent({ name, description: `${name} does its job`, instructions: "Do it.", startable: true, ...extra });
    return t.agents.get(name) ? t.agents.update(def) : t.agents.create(def);
  };
  return { ...t, scheduler, triggers, save };
}

test("run_agent offers the enabled startable agents in voice and chat, and starts one with the request and the channel as trigger", async () => {
  const t = setup();
  t.save("weekly-review");
  t.save("security-sweep", { startable: false });
  t.save("drafts", { enabled: false });
  t.triggers.start();

  const tool = t.registry.get(RUN_AGENT)!;
  assert.deepEqual(tool.channels, ["voice", "chat"]);
  assert.deepEqual(tool.parameters!.properties!.agent.enum, ["weekly-review"]);
  assert.match(tool.description, /runs in the background[\s\S]*- weekly-review: weekly-review does its job/);
  assert.ok(!t.registry.declarations("agent").some((d) => d.name === RUN_AGENT), "agents can't start agents");
  assert.equal(t.registry.list().find((e) => e.name === RUN_AGENT)!.owner, "core");

  const r = await t.registry.callTool(RUN_AGENT, { agent: "weekly-review", request: "for this week" }, { channel: "voice", conversationId: "c-1" });
  assert.deepEqual(r.result, { started: true, agent: "weekly-review", note: "It runs in the background; its result is not returned here." });
  const run = t.runtime.running("weekly-review") ?? t.runs.last("weekly-review")!;
  assert.deepEqual([run.trigger, run.request], ["voice", "for this week"]);
});

test("run_agent refuses agents that are not startable, disabled, unknown or already running", async () => {
  const t = setup([{ waitMs: 50, chunks: [text("Done.")] }]);
  t.save("weekly-review");
  t.save("security-sweep", { startable: false });
  t.save("drafts", { enabled: false });
  t.triggers.start();
  const call = (agent: string) => t.registry.callTool(RUN_AGENT, { agent }, { channel: "chat" });
  for (const name of ["security-sweep", "drafts", "nobody"]) {
    assert.deepEqual((await call(name)).result, { error: `there is no agent "${name}" that can be started by voice or chat` });
  }
  assert.equal(((await call("weekly-review")).result as { started?: boolean }).started, true);
  assert.equal(t.runs.last("weekly-review")!.trigger, "chat");
  assert.deepEqual((await call("weekly-review")).result, { error: "weekly-review is already running, since 12:00" });
  const long = await t.registry.callTool(RUN_AGENT, { agent: "weekly-review", request: "x".repeat(2001) }, { channel: "voice" });
  assert.deepEqual(long.result, { error: "request is longer than 2000 characters" });
  await t.runtime.stop();
});

test("run_agent is rebuilt on every change and removed when no agent is startable", () => {
  const t = setup();
  t.triggers.start();
  assert.equal(t.registry.has(RUN_AGENT), false);
  t.save("weekly-review");
  assert.deepEqual(t.registry.get(RUN_AGENT)!.parameters!.properties!.agent.enum, ["weekly-review"]);
  t.save("security-sweep");
  assert.deepEqual(t.registry.get(RUN_AGENT)!.parameters!.properties!.agent.enum, ["security-sweep", "weekly-review"]);
  t.save("security-sweep", { enabled: false });
  t.save("weekly-review", { startable: false });
  assert.equal(t.registry.has(RUN_AGENT), false);
  t.save("weekly-review");
  t.agents.delete("weekly-review");
  assert.equal(t.registry.has(RUN_AGENT), false);
});
