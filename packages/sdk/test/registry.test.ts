import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, Type } from "../src/index.js";

const quiet = { error() {} };

test("add registers with owner and duplicate names throw regardless of owner", () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "t", description: "d", handler: () => ({}) });
  assert.deepEqual(r.list(), [{ name: "t", owner: "a", description: "d" }]);
  assert.throws(() => r.add("b", { name: "t", description: "d", handler: () => ({}) }), /duplicate tool t/);
});

test("declarations use parametersJsonSchema when present, parameters otherwise", () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "native", description: "n", parameters: { type: Type.OBJECT }, handler: () => ({}) });
  r.add("a", { name: "mcp", description: "m", parametersJsonSchema: { type: "object" }, handler: () => ({}) });
  assert.deepEqual(r.declarations(), [
    { name: "native", description: "n", parameters: { type: "OBJECT" } },
    { name: "mcp", description: "m", parametersJsonSchema: { type: "object" } },
  ]);
});

test("declarations is a snapshot", () => {
  const r = new ToolRegistry(quiet);
  const before = r.declarations();
  r.add("a", { name: "t", description: "d", handler: () => ({}) });
  assert.equal(before.length, 0);
  assert.equal(r.declarations().length, 1);
});

test("removeOwner removes only that owner's tools and returns the count", () => {
  const r = new ToolRegistry(quiet);
  r.add("mcp:home", { name: "a", description: "", handler: () => ({}) });
  r.add("mcp:home", { name: "b", description: "", handler: () => ({}) });
  r.add("mcp:home", { name: "c", description: "", handler: () => ({}) });
  r.add("builtin", { name: "d", description: "", handler: () => ({}) });
  assert.equal(r.removeOwner("mcp:home"), 3);
  assert.deepEqual(r.names(), ["d"]);
  assert.equal(r.removeOwner("nobody"), 0);
});

test("onChange fires on add and remove, and unsubscribes", () => {
  const r = new ToolRegistry(quiet);
  let n = 0;
  const off = r.onChange(() => n++);
  r.add("a", { name: "t", description: "", handler: () => ({}) });
  r.removeOwner("a");
  assert.equal(n, 2);
  off();
  r.add("a", { name: "t", description: "", handler: () => ({}) });
  assert.equal(n, 2);
});

test("scheduling resolution: default, tool-level, per-call override (stripped)", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "plain", description: "", handler: () => ({ x: 1 }) });
  r.add("a", { name: "idle", description: "", scheduling: "WHEN_IDLE", handler: () => ({ x: 1 }) });
  r.add("a", { name: "override", description: "", scheduling: "WHEN_IDLE", handler: () => ({ x: 1, scheduling: "SILENT" }) });
  r.add("a", { name: "bogus", description: "", handler: () => ({ x: 1, scheduling: "LATER" }) });
  assert.deepEqual(await r.callTool("plain", {}), { result: { x: 1 }, scheduling: "INTERRUPT" });
  assert.deepEqual(await r.callTool("idle", undefined), { result: { x: 1 }, scheduling: "WHEN_IDLE" });
  assert.deepEqual(await r.callTool("override", {}), { result: { x: 1 }, scheduling: "SILENT" });
  assert.deepEqual(await r.callTool("bogus", {}), { result: { x: 1 }, scheduling: "INTERRUPT" });
});

test("endConversation is stripped from the result and returned separately", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "end", description: "", scheduling: "SILENT", handler: () => ({ ending: true, endConversation: "user said goodbye" }) });
  r.add("a", { name: "notstring", description: "", handler: () => ({ endConversation: true }) });
  assert.deepEqual(await r.callTool("end", {}), { result: { ending: true }, scheduling: "SILENT", endConversation: "user said goodbye" });
  assert.deepEqual(await r.callTool("notstring", {}), { result: {}, scheduling: "INTERRUPT" });
});

test("unknown tool and throwing handler produce error results with INTERRUPT", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "boom", description: "", scheduling: "SILENT", handler: () => { throw new Error("kaboom"); } });
  r.add("a", { name: "reject", description: "", handler: async () => { throw new Error("nope"); } });
  assert.deepEqual(await r.callTool("nope", {}), { result: { error: "unknown tool nope" }, scheduling: "INTERRUPT" });
  assert.deepEqual(await r.callTool("boom", {}), { result: { error: "Error: kaboom" }, scheduling: "INTERRUPT" });
  assert.deepEqual(await r.callTool("reject", {}), { result: { error: "Error: nope" }, scheduling: "INTERRUPT" });
});

test("handler receives an empty object when args are undefined", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "echo", description: "", handler: (args) => ({ args }) });
  assert.deepEqual((await r.callTool("echo", undefined)).result, { args: {} });
});

test("tools without channels are offered in both channels", () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "t", description: "", handler: () => ({}) });
  assert.deepEqual(r.declarations("voice").map((d) => d.name), ["t"]);
  assert.deepEqual(r.declarations("chat").map((d) => d.name), ["t"]);
});

test("declarations narrow to a channel; without one they list every tool", () => {
  const r = new ToolRegistry(quiet);
  r.add("builtin", { name: "set_timer", description: "", channels: ["voice"], handler: () => ({}) });
  r.add("builtin", { name: "get_current_time", description: "", handler: () => ({}) });
  r.add("x", { name: "chat_only", description: "", channels: ["chat"], handler: () => ({}) });
  assert.deepEqual(r.declarations("chat").map((d) => d.name), ["get_current_time", "chat_only"]);
  assert.deepEqual(r.declarations("voice").map((d) => d.name), ["set_timer", "get_current_time"]);
  assert.deepEqual(r.declarations().map((d) => d.name), ["set_timer", "get_current_time", "chat_only"]);
  assert.equal("channels" in r.declarations()[0], false);
});

test("add rejects empty or unknown channels", () => {
  const r = new ToolRegistry(quiet);
  assert.throws(() => r.add("a", { name: "e", description: "", channels: [], handler: () => ({}) }), /invalid channels for e/);
  assert.throws(() => r.add("a", { name: "u", description: "", channels: ["email" as never], handler: () => ({}) }), /invalid channels for u/);
  assert.equal(r.has("e") || r.has("u"), false);
});

test("callTool restricted to a channel treats out-of-channel tools as unknown", async () => {
  const r = new ToolRegistry(quiet);
  let ran = 0;
  r.add("builtin", { name: "set_timer", description: "", channels: ["voice"], handler: () => (ran++, { done: true }) });
  assert.deepEqual(await r.callTool("set_timer", { seconds: 60 }, { channel: "chat" }), {
    result: { error: "unknown tool set_timer" },
    scheduling: "INTERRUPT",
  });
  assert.equal(ran, 0);
  assert.deepEqual((await r.callTool("set_timer", {}, { channel: "voice" })).result, { done: true });
  assert.deepEqual((await r.callTool("set_timer", {})).result, { done: true });
  assert.equal(ran, 2);
});

test("callTool hands the handler its channel and conversation id", async () => {
  const r = new ToolRegistry(quiet);
  const seen: unknown[] = [];
  r.add("brain", { name: "t", description: "", handler: (_args, call) => (seen.push(call), {}) });
  await r.callTool("t", {}, { channel: "chat", conversationId: "c1" });
  await r.callTool("t", {}, { channel: "voice" });
  await r.callTool("t", {});
  assert.deepEqual(seen, [{ channel: "chat", conversationId: "c1" }, { channel: "voice" }, {}]);
});

test("callTool hands the handler the device the call comes from, and none without options", async () => {
  const r = new ToolRegistry(quiet);
  const seen: unknown[] = [];
  r.add("core", { name: "t", description: "", handler: (_args, call) => (seen.push(call), {}) });
  await r.callTool("t", {}, { channel: "voice", conversationId: "c1", device: "friday-kitchen" });
  await r.callTool("t", {}, { channel: "voice" });
  await r.callTool("t", {});
  assert.deepEqual(seen, [{ channel: "voice", conversationId: "c1", device: "friday-kitchen" }, { channel: "voice" }, {}]);
});

test("a handler that takes only its args behaves as before", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "echo", description: "", handler: (args: { x?: number }) => ({ x: args.x }) });
  assert.deepEqual(await r.callTool("echo", { x: 1 }, { channel: "chat", conversationId: "c1" }), { result: { x: 1 }, scheduling: "INTERRUPT" });
});
