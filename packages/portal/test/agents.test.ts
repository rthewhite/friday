import { test } from "node:test";
import assert from "node:assert/strict";
import { agentStatus, describeSchedule, matching, patternRegExp, runDuration } from "../src/lib/agents.ts";

const tools = ["github__get_file", "github__list_repos", "github__create_pull_request", "a.b", "aXb", "calendar_list_events"];

test("patterns match like core: * matches any run of characters, everything else only itself", () => {
  assert.deepEqual(matching("github__get_*", tools), ["github__get_file"]);
  assert.deepEqual(matching("github__*", tools), ["github__get_file", "github__list_repos", "github__create_pull_request"]);
  assert.deepEqual(matching("a.b", tools), ["a.b"]);
  assert.deepEqual(matching("*", tools), tools);
  assert.deepEqual(matching("slack__*", tools), []);
  assert.deepEqual(matching("  ", tools), []);
  assert.ok(!patternRegExp("github__get_*").test("x_github__get_file"));
});

test("common schedules read as words; others stay cron", () => {
  assert.equal(describeSchedule(undefined), "on demand");
  assert.equal(describeSchedule("0 7 * * *"), "daily at 07:00");
  assert.equal(describeSchedule("30 18 * * 0"), "Sundays at 18:30");
  assert.equal(describeSchedule("0 18 * * 7"), "Sundays at 18:00");
  assert.equal(describeSchedule("0 8 * * 1-5"), "weekdays at 08:00");
  assert.equal(describeSchedule("*/15 * * * *"), "*/15 * * * *");
  assert.equal(describeSchedule("0 9 1 * *"), "0 9 1 * *");
});

test("status and durations of runs", () => {
  const run = { startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:03:04.000Z", outcome: "budget_exceeded" as const };
  assert.equal(runDuration(run), "3 min 4 s");
  assert.equal(runDuration({ startedAt: run.startedAt, endedAt: null }), "");
  assert.deepEqual(agentStatus({ running: null, lastRun: run as never }), { label: "budget exceeded", tone: "warning" });
  assert.deepEqual(agentStatus({ running: run as never, lastRun: null }), { label: "running", tone: "accent" });
  assert.deepEqual(agentStatus({ running: null, lastRun: null }), { label: "never run", tone: "neutral" });
});
