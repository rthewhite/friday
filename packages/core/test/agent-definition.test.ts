import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "@friday/sdk";
import { AgentInputError, parseAgent, patternRegExp, resolveTools } from "../src/agents/definition.js";

const base = { name: "weekly-review", description: "Sums up my week", instructions: "Look at the calendar." };

test("defaults: enabled, not startable, no schedule, no tools, default budgets; text is trimmed", () => {
  assert.deepEqual(parseAgent({ ...base, description: "  Sums up my week ", schedule: "" }), {
    ...base,
    enabled: true,
    startable: false,
    tools: [],
    budgets: { maxToolCalls: 30, maxTokens: 200000, maxMinutes: 10 },
  });
  assert.equal(parseAgent({ ...base, schedule: " 0  18 * * 0 " }).schedule, "0 18 * * 0");
});

test("every invalid field is refused with a message naming it", () => {
  const bad: [string, unknown, RegExp][] = [
    ["not an object", [], /JSON object/],
    ["spaces in the name", { ...base, name: "Weekly Review" }, /kebab-case/],
    ["name too long", { ...base, name: "a".repeat(41) }, /at most 40/],
    ["empty description", { ...base, description: " " }, /description must be one line/],
    ["two-line description", { ...base, description: "a\nb" }, /one line/],
    ["empty instructions", { ...base, instructions: "" }, /instructions must be/],
    ["instructions too long", { ...base, instructions: "x".repeat(20001) }, /instructions must be 1 to 20000/],
    ["schedule in words", { ...base, schedule: "every sunday" }, /not a five-field cron expression/],
    ["six-field schedule", { ...base, schedule: "0 0 18 * * 0" }, /five-field/],
    ["enabled not boolean", { ...base, enabled: "yes" }, /enabled must be true or false/],
    ["tools not a list", { ...base, tools: "calendar_*" }, /tools must be a list/],
    ["tool without pattern", { ...base, tools: [{ mode: "auto" }] }, /needs a pattern/],
    ["pattern with a space", { ...base, tools: [{ pattern: "calendar list", mode: "auto" }] }, /may only contain/],
    ["bad mode", { ...base, tools: [{ pattern: "x", mode: "always" }] }, /must be auto or approve/],
    ["too many tools", { ...base, tools: Array.from({ length: 51 }, () => ({ pattern: "x", mode: "auto" })) }, /at most 50/],
    ["minutes out of range", { ...base, budgets: { maxMinutes: 120 } }, /maxMinutes must be a whole number from 1 to 60/],
    ["tokens below range", { ...base, budgets: { maxTokens: 10 } }, /maxTokens must be a whole number from 10000/],
    ["fractional tool calls", { ...base, budgets: { maxToolCalls: 2.5 } }, /maxToolCalls/],
  ];
  for (const [label, body, re] of bad) {
    assert.throws(() => parseAgent(body), (e: unknown) => e instanceof AgentInputError && re.test(e.message), label);
  }
});

test("an update takes the name from the path and refuses a different one", () => {
  assert.equal(parseAgent({ description: "d", instructions: "i" }, "weekly-review").name, "weekly-review");
  assert.equal(parseAgent({ ...base }, "weekly-review").name, "weekly-review");
  assert.throws(() => parseAgent({ ...base, name: "other" }, "weekly-review"), /name cannot be changed/);
});

function registry() {
  const r = new ToolRegistry({ error() {} });
  const add = (owner: string, name: string, channels?: ("voice" | "chat" | "agent")[]) => r.add(owner, { name, description: name, ...(channels ? { channels } : {}), handler: () => ({}) });
  add("mcp:github", "github__get_file");
  add("mcp:github", "github__list_repos");
  add("mcp:github", "github__create_pull_request", ["agent"]);
  add("mcp:github", "github__merge_pull_request");
  add("core", "set_timer", ["voice"]);
  add("core", "run_agent", ["voice", "chat"]);
  add("x", "a.b");
  add("x", "aXb");
  return r;
}

test("patterns select agent-channel tools; approve wins; unmatched patterns are reported", () => {
  const { tools, unmatched } = resolveTools(
    parseAgent({
      ...base,
      tools: [
        { pattern: "github__get_*", mode: "auto" },
        { pattern: "github__list_*", mode: "auto" },
        { pattern: "github__create_pull_request", mode: "approve" },
        { pattern: "set_timer", mode: "auto" },
        { pattern: "run_agent", mode: "auto" },
      ],
    }),
    registry(),
  );
  assert.deepEqual([...tools], [["github__get_file", "auto"], ["github__list_repos", "auto"], ["github__create_pull_request", "approve"]]);
  assert.deepEqual(unmatched, ["set_timer", "run_agent"]);
});

test("the stricter mode wins whatever the order of the entries", () => {
  for (const order of [[0, 1], [1, 0]]) {
    const entries = [{ pattern: "github__*", mode: "auto" }, { pattern: "github__create_pull_request", mode: "approve" }];
    const { tools } = resolveTools(parseAgent({ ...base, tools: order.map((i) => entries[i]) }), registry());
    assert.equal(tools.get("github__create_pull_request"), "approve");
    assert.equal(tools.get("github__merge_pull_request"), "auto");
  }
});

test("regular-expression characters in a pattern match only themselves", () => {
  assert.ok(patternRegExp("a.b").test("a.b"));
  assert.ok(!patternRegExp("a.b").test("aXb"));
  assert.ok(patternRegExp("*").test("anything"));
  assert.ok(!patternRegExp("github__get_*").test("x_github__get_file"));
  const { tools } = resolveTools(parseAgent({ ...base, tools: [{ pattern: "a.b", mode: "auto" }] }), registry());
  assert.deepEqual([...tools.keys()], ["a.b"]);
});
