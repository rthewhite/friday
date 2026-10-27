import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, PromptContext, ToolRegistry, type PromptContextInfo, type RouteRequest, type ToolCallContext } from "../src/index.js";
import { createTestHost, TEST_USER } from "../src/test.js";

const sanne = { id: "u2", name: "Sanne", role: "member" as const };

/** A module that reports who its route, its tool and its prompt saw. */
function probe() {
  const seen: { route?: RouteRequest["user"] | "none"; call?: ToolCallContext; prompt?: PromptContextInfo } = {};
  const module = defineModule({
    manifest: { id: "probe", label: "Probe" },
    init(ctx) {
      ctx.http.route("GET", "who", (req, res) => {
        seen.route = req.user ?? "none";
        res.json({ ok: true });
      });
      ctx.defineTool({ name: "who", description: "who", handler: (_a, call) => ((seen.call = call), {}) });
      ctx.prompt.addContext((info) => ((seen.prompt = info), "x"));
    },
  });
  return { module, seen };
}

test("route requests carry the host's user, else an admin test user; per request it can be replaced or left out", async () => {
  const a = probe();
  const plain = await createTestHost(a.module);
  await plain.request("GET", "who");
  assert.deepEqual(a.seen.route, TEST_USER);
  assert.equal(TEST_USER.role, "admin");
  await plain.request("GET", "who", undefined, {}, { user: null });
  assert.equal(a.seen.route, "none");

  const b = probe();
  const host = await createTestHost(b.module, { user: sanne });
  await host.request("GET", "who");
  assert.deepEqual(b.seen.route, sanne);
  await host.request("GET", "who", undefined, {}, { user: { id: "u1", name: "Owner", role: "admin" } });
  assert.deepEqual(b.seen.route, { id: "u1", name: "Owner", role: "admin" });
});

test("tool calls carry the host's user as { id, name }, none without the option, and can omit it per call", async () => {
  const a = probe();
  const plain = await createTestHost(a.module);
  await plain.call("who");
  assert.deepEqual(a.seen.call, {});

  const b = probe();
  const host = await createTestHost(b.module, { user: sanne });
  await host.call("who", {}, { channel: "chat" });
  assert.deepEqual(b.seen.call, { channel: "chat", user: { id: "u2", name: "Sanne" } });
  await host.call("who", {}, { user: undefined });
  assert.deepEqual(b.seen.call, {});
});

test("prompt providers get the user the prompt is for, and only the channel without one", async () => {
  const b = probe();
  const host = await createTestHost(b.module, { user: sanne });
  host.promptContext("chat");
  assert.deepEqual(b.seen.prompt, { channel: "chat", user: { id: "u2", name: "Sanne" } });
  host.promptContext("voice", null);
  assert.deepEqual(b.seen.prompt, { channel: "voice" });
  host.promptContext("chat", { id: "u1", name: "Owner" });
  assert.deepEqual(b.seen.prompt, { channel: "chat", user: { id: "u1", name: "Owner" } });
});

test("the registry hands the user to the handler without extra fields; PromptContext.render passes it on", async () => {
  const registry = new ToolRegistry({ log() {}, warn() {}, error() {} });
  let seen: ToolCallContext | undefined;
  registry.add("m", { name: "t", description: "t", handler: (_a, c) => ((seen = c), {}) });
  await registry.callTool("t", {}, { channel: "chat", user: { id: "u2", name: "Sanne", role: "member" } as never });
  assert.deepEqual(seen, { channel: "chat", user: { id: "u2", name: "Sanne" } });

  const prompts = new PromptContext({ log: { log() {}, warn() {}, error() {} } });
  let info: PromptContextInfo | undefined;
  prompts.forOwner("m").addContext((i) => ((info = i), undefined));
  prompts.render("voice");
  assert.deepEqual(info, { channel: "voice" });
  prompts.render("chat", { id: "u2", name: "Sanne" });
  assert.deepEqual(info, { channel: "chat", user: { id: "u2", name: "Sanne" } });
});
