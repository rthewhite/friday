import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAgent } from "../src/agents/definition.js";
import { ACTION_TTL_MS, AgentExists, AgentRunStore, AgentStore, KEEP_RUNS } from "../src/agents/store.js";
import { migrate, migrations, openDatabase } from "../src/storage/db.js";

const quiet = { log() {} };

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const clock = { t: Date.parse("2026-10-21T10:00:00.000Z"), advance(ms: number) { this.t += ms; } };
  const now = () => new Date(clock.t);
  return { db, clock, agents: new AgentStore(db, now), runs: new AgentRunStore(db, now) };
}

const review = (extra: Record<string, unknown> = {}) =>
  parseAgent({ name: "weekly-review", description: "Sums up my week", instructions: "Look at the calendar.", schedule: "0 18 * * 0", tools: [{ pattern: "calendar_*", mode: "auto" }], ...extra });

test("definitions round-trip with defaults, survive reopening, and report each change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-agents-"));
  const db = openDatabase(dir, "friday.db", quiet);
  const agents = new AgentStore(db);
  const changed: string[] = [];
  agents.onChange((n) => changed.push(n));
  const created = agents.create(review());
  assert.deepEqual({ ...created, createdAt: undefined, updatedAt: undefined }, {
    name: "weekly-review",
    description: "Sums up my week",
    instructions: "Look at the calendar.",
    schedule: "0 18 * * 0",
    enabled: true,
    startable: false,
    tools: [{ pattern: "calendar_*", mode: "auto" }],
    budgets: { maxToolCalls: 30, maxTokens: 200000, maxMinutes: 10 },
    createdBy: null,
    createdAt: undefined,
    updatedAt: undefined,
  });
  assert.throws(() => agents.create(review()), AgentExists);
  assert.equal(agents.update(review({ schedule: "", enabled: false }))!.schedule, undefined);
  assert.equal(agents.update(parseAgent({ name: "nobody", description: "d", instructions: "i" })), undefined);
  db.close();

  const again = new AgentStore(openDatabase(dir, "friday.db", quiet));
  assert.deepEqual(again.list().map((a) => [a.name, a.enabled]), [["weekly-review", false]]);
  assert.equal(again.delete("weekly-review"), true);
  assert.equal(again.delete("weekly-review"), false);
  assert.deepEqual(changed, ["weekly-review", "weekly-review"]);
});

test("a run records its progress and outcome; runs left running fail at startup", () => {
  const { agents, runs, clock } = setup();
  agents.create(review());
  const run = runs.start({ agent: "weekly-review", trigger: "voice", request: "for this week" });
  assert.deepEqual([run.outcome, run.trigger, run.request, run.endedAt], ["running", "voice", "for this week", null]);
  runs.progress(run.id, { conversationId: "c-1", toolCalls: 2, tokens: 1200 });
  clock.advance(5000);
  const done = runs.finish(run.id, { outcome: "ok", summary: "Busy week", toolCalls: 3, tokens: 2000 })!;
  assert.deepEqual([done.outcome, done.summary, done.toolCalls, done.tokens, done.conversationId, done.endedAt], ["ok", "Busy week", 3, 2000, "c-1", "2026-10-21T10:00:05.000Z"]);

  const stuck = runs.start({ agent: "weekly-review", trigger: "schedule" });
  const approving = runs.park({ runId: run.id, agent: "weekly-review", tool: "notify", args: {} });
  runs.claim(approving.id);
  assert.equal(runs.failInterrupted(), 2);
  assert.deepEqual([runs.get(stuck.id)!.outcome, runs.get(stuck.id)!.error], ["failed", "interrupted by a restart"]);
  assert.deepEqual([runs.action(approving.id)!.state, runs.action(approving.id)!.error], ["failed", "interrupted by a restart; the call may or may not have happened"]);
  assert.deepEqual(runs.list("weekly-review").map((r) => r.id), [stuck.id, run.id]);
});

test(`pruning keeps ${KEEP_RUNS} runs per agent plus runs with a pending action`, () => {
  const { agents, runs, clock } = setup();
  agents.create(review());
  const first = runs.start({ agent: "weekly-review", trigger: "schedule" });
  const action = runs.park({ runId: first.id, agent: "weekly-review", tool: "notify", args: { text: "hi" } });
  runs.finish(first.id, { outcome: "ok", toolCalls: 1, tokens: 1 });
  const second = runs.start({ agent: "weekly-review", trigger: "schedule" });
  runs.finish(second.id, { outcome: "ok", toolCalls: 0, tokens: 1 });
  for (let i = 0; i < KEEP_RUNS; i++) {
    clock.advance(1000);
    runs.finish(runs.start({ agent: "weekly-review", trigger: "schedule" }).id, { outcome: "ok", toolCalls: 0, tokens: 1 });
  }
  assert.ok(runs.get(first.id), "kept for its pending action");
  assert.equal(runs.get(second.id), undefined);
  assert.equal(runs.list("weekly-review", 100).length, KEEP_RUNS + 1);
  assert.equal(runs.reject(action.id), "ok");
  clock.advance(1000);
  runs.finish(runs.start({ agent: "weekly-review", trigger: "schedule" }).id, { outcome: "ok", toolCalls: 0, tokens: 1 });
  assert.equal(runs.get(first.id), undefined);
});

test("actions are decided once, expire after 7 days, and go with their agent", () => {
  const { agents, runs, clock, db } = setup();
  agents.create(review());
  const run = runs.start({ agent: "weekly-review", trigger: "portal" });
  const a = runs.park({ runId: run.id, agent: "weekly-review", tool: "github__create_pull_request", args: { title: "Bump" } });
  assert.deepEqual([a.state, a.tool, a.args], ["pending", "github__create_pull_request", { title: "Bump" }]);
  assert.equal(runs.pendingCount("weekly-review"), 1);

  assert.equal(runs.claim(a.id), "ok");
  assert.equal(runs.claim(a.id), "conflict");
  assert.equal(runs.reject(a.id), "conflict");
  assert.deepEqual(runs.settle(a.id, { state: "executed", result: { url: "pr/1" } })!.result, { url: "pr/1" });
  assert.equal(runs.claim("nope"), "missing");

  const old = runs.park({ runId: run.id, agent: "weekly-review", tool: "notify", args: {} });
  clock.advance(ACTION_TTL_MS);
  assert.equal(runs.claim(old.id), "expired");
  assert.equal(runs.action(old.id)!.state, "expired");
  assert.equal(runs.pendingCount("weekly-review"), 0);

  agents.delete("weekly-review");
  assert.deepEqual([...db.prepare("SELECT COUNT(*) AS n FROM agent_actions").all()].map((r) => ({ ...r })), [{ n: 0 }]);
  assert.equal(runs.get(run.id), undefined);
});

test("an agent records its creator; listing and getOwn are per creator; names stay unique across users", () => {
  const { db, agents } = setup();
  db.exec("INSERT INTO users (id, issuer, subject, name, role, first_login_at, last_login_at) VALUES ('u1', 'i', 's1', 'Raymond', 'admin', 't', 't'), ('u2', 'i', 's2', 'Sanne', 'member', 't', 't')");
  agents.create(review(), "u1");
  agents.create(review({ name: "her-digest" }), "u2");
  assert.deepEqual(agents.get("weekly-review")!.createdBy, { id: "u1", name: "Raymond" });
  assert.deepEqual(agents.list("u2").map((a) => a.name), ["her-digest"]);
  assert.deepEqual(agents.list().map((a) => a.name), ["her-digest", "weekly-review"]);
  assert.equal(agents.getOwn("weekly-review", "u1")?.name, "weekly-review");
  assert.equal(agents.getOwn("weekly-review", "u2"), undefined);
  assert.equal(agents.getOwn("weekly-review", undefined), undefined);
  assert.throws(() => agents.create(review(), "u2"), (e) => e instanceof AgentExists && e.message === 'the name "weekly-review" is already in use');
});
