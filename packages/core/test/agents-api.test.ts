import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { AgentTriggers } from "../src/agents/triggers.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { JobStore } from "../src/jobs/store.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { agentHarness, quiet } from "./agent-harness.js";
import { FakeClock } from "./fake-clock.js";
import { call, text, type Round } from "./fake-stream.js";
import { waitFor } from "./helpers.js";

async function start(rounds: Round[] = [{ chunks: [text("Done.")] }], o: { agents?: boolean } = {}) {
  const t = agentHarness(rounds);
  t.tool("calendar_list_events");
  t.tool("github__create_pull_request", () => ({ url: "pr/7" }), ["agent"]);
  t.tool("set_timer", undefined, ["voice"]);
  const jobs = new JobStore(t.db);
  const scheduler = new Scheduler({ store: jobs, clock: new FakeClock(Date.parse("2026-10-21T10:00:00Z")), log: quiet, timezone: "Europe/Amsterdam" });
  new AgentTriggers({ agents: t.agents, runtime: t.runtime, registry: t.registry, scheduler, jobs, timezone: () => "Europe/Amsterdam", log: quiet }).start();
  const agents = o.agents === false ? undefined : {
    agents: t.agents, runs: t.runs, runtime: t.runtime, registry: t.registry,
    nextRun: (name: string) => scheduler.list().find((j) => j.id === `core/agent-${name}`)?.nextRunAt ?? null,
  };
  const host = new ModuleHost(t.registry, { env: {}, log: quiet });
  const server = createServer(createApp({ registry: t.registry, host, mcp: new McpSource(t.registry, undefined, { log: quiet }), webDir: "/nonexistent", conversations: t.conversations, jobs: scheduler, agents }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const raw = await r.text();
    return { status: r.status, json: raw ? JSON.parse(raw) : undefined };
  };
  const close = async () => {
    await t.runtime.stop();
    await scheduler.stop();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  return { ...t, scheduler, req, close };
}

const review = { name: "weekly-review", description: "Sums up my week", instructions: "Look at the calendar.", schedule: "0 18 * * 0", tools: [{ pattern: "calendar_*", mode: "auto" }, { pattern: "github__*", mode: "approve" }] };

test("create, list, read, replace: validation 400, duplicate 409, rename 400, unknown 404", async () => {
  const s = await start();
  try {
    const created = await s.req("POST", "/api/agents", { ...review, tools: [...review.tools, { pattern: "slack__*", mode: "auto" }] });
    assert.equal(created.status, 201);
    assert.deepEqual([created.json.name, created.json.enabled, created.json.unmatched, created.json.nextRunAt, created.json.pendingActions, created.json.running, created.json.lastRun], ["weekly-review", true, ["slack__*"], "2026-10-25T17:00:00.000Z", 0, null, null]);

    const bad = await s.req("POST", "/api/agents", { ...review, name: "Weekly Review" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /kebab-case/);
    assert.equal((await s.req("POST", "/api/agents", "{nope")).status, 400);
    assert.equal((await s.req("POST", "/api/agents", review)).status, 409);

    assert.deepEqual((await s.req("GET", "/api/agents")).json.agents.map((a: { name: string }) => a.name), ["weekly-review"]);
    assert.equal((await s.req("GET", "/api/agents/weekly-review")).json.description, "Sums up my week");
    assert.equal((await s.req("GET", "/api/agents/nobody")).status, 404);

    const put = await s.req("PUT", "/api/agents/weekly-review", { ...review, description: "My week", schedule: "" });
    assert.deepEqual([put.status, put.json.description, put.json.schedule, put.json.nextRunAt], [200, "My week", undefined, null]);
    assert.equal((await s.req("PUT", "/api/agents/weekly-review", { ...review, name: "other" })).status, 400);
    assert.equal((await s.req("PUT", "/api/agents/nobody", review)).status, 404);
  } finally {
    await s.close();
  }
});

test("GET /api/agents/tools lists the tools offered to agents, without voice-only ones", async () => {
  const s = await start();
  try {
    const { json } = await s.req("GET", "/api/agents/tools");
    assert.deepEqual(json.tools.map((t: { name: string; owner: string }) => [t.name, t.owner]), [["calendar_list_events", "test"], ["github__create_pull_request", "mcp:github"]]);
  } finally {
    await s.close();
  }
});

test("run 202, then 409 while it runs; runs newest first; a run with its actions; cancel", async () => {
  const s = await start([{ waitMs: Infinity }]);
  try {
    await s.req("POST", "/api/agents", review);
    const r = await s.req("POST", "/api/agents/weekly-review/run", { request: "only this week" });
    assert.equal(r.status, 202);
    const busy = await s.req("POST", "/api/agents/weekly-review/run", {});
    assert.deepEqual([busy.status, busy.json.runId], [409, r.json.runId]);
    assert.equal((await s.req("POST", "/api/agents/nobody/run", {})).status, 404);
    assert.equal((await s.req("POST", "/api/agents/weekly-review/run", { request: 7 })).status, 400);

    assert.equal((await s.req("GET", "/api/agents/weekly-review")).json.running.id, r.json.runId);
    const runs = (await s.req("GET", "/api/agents/weekly-review/runs")).json.runs;
    assert.deepEqual(runs.map((x: { id: string; trigger: string; request: string }) => [x.id, x.trigger, x.request]), [[r.json.runId, "portal", "only this week"]]);

    assert.equal((await s.req("POST", `/api/agents/runs/${r.json.runId}/cancel`)).status, 202);
    await waitFor(() => s.runs.get(r.json.runId)!.outcome === "cancelled");
    assert.equal((await s.req("POST", `/api/agents/runs/${r.json.runId}/cancel`)).status, 409);
    const one = await s.req("GET", `/api/agents/runs/${r.json.runId}`);
    assert.deepEqual([one.json.outcome, one.json.actions], ["cancelled", []]);
    assert.equal((await s.req("GET", "/api/agents/runs/nope")).status, 404);
  } finally {
    await s.close();
  }
});

test("approve and reject answer 409 once an action is decided, 404 for unknown ones", async () => {
  const s = await start([{ chunks: [call("github__create_pull_request", { title: "a" }), call("github__create_pull_request", { title: "b" })] }, { chunks: [text("Queued two.")] }]);
  try {
    await s.req("POST", "/api/agents", review);
    const { json } = await s.req("POST", "/api/agents/weekly-review/run", {});
    await waitFor(() => s.runs.get(json.runId)!.outcome === "ok");
    const run = (await s.req("GET", `/api/agents/runs/${json.runId}`)).json;
    const [a, b] = run.actions;
    assert.equal((await s.req("GET", "/api/agents/weekly-review")).json.pendingActions, 2);

    const approved = await s.req("POST", `/api/agents/actions/${a.id}/approve`);
    assert.deepEqual([approved.status, approved.json.state, approved.json.result], [200, "executed", { url: "pr/7" }]);
    assert.equal((await s.req("POST", `/api/agents/actions/${a.id}/approve`)).status, 409);
    assert.equal((await s.req("POST", `/api/agents/actions/${b.id}/reject`)).json.state, "rejected");
    assert.equal((await s.req("POST", `/api/agents/actions/${b.id}/approve`)).status, 409);
    assert.equal((await s.req("POST", "/api/agents/actions/nope/reject")).status, 404);
    assert.equal((await s.req("GET", "/api/agents/weekly-review")).json.pendingActions, 0);
  } finally {
    await s.close();
  }
});

test("deleting a running agent cancels the run, removes the agent, its runs and its job", async () => {
  const s = await start([{ waitMs: Infinity }]);
  try {
    await s.req("POST", "/api/agents", review);
    const { json } = await s.req("POST", "/api/agents/weekly-review/run", {});
    assert.deepEqual(s.scheduler.list().map((j) => j.id), ["core/agent-weekly-review"]);
    const del = await s.req("DELETE", "/api/agents/weekly-review");
    assert.equal(del.status, 204);
    assert.equal(s.runtime.running("weekly-review"), undefined);
    assert.equal(s.runs.get(json.runId), undefined);
    assert.deepEqual(s.scheduler.list(), []);
    assert.equal((await s.req("GET", "/api/agents/weekly-review")).status, 404);
    assert.equal((await s.req("DELETE", "/api/agents/weekly-review")).status, 404);
  } finally {
    await s.close();
  }
});

test("a disabled agent has no job but can still be run from the portal", async () => {
  const s = await start();
  try {
    await s.req("POST", "/api/agents", { ...review, enabled: false });
    assert.deepEqual(s.scheduler.list(), []);
    const r = await s.req("POST", "/api/agents/weekly-review/run", {});
    assert.equal(r.status, 202);
    await waitFor(() => s.runs.get(r.json.runId)!.outcome === "ok");
    assert.equal(s.runs.get(r.json.runId)!.trigger, "portal");
  } finally {
    await s.close();
  }
});

test("without agents the API answers 503", async () => {
  const s = await start(undefined, { agents: false });
  try {
    assert.equal((await s.req("GET", "/api/agents")).status, 503);
    assert.equal((await s.req("POST", "/api/agents/actions/x/approve")).status, 503);
  } finally {
    await s.close();
  }
});
