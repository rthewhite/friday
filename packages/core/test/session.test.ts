import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "@friday/sdk";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai";
import { GeminiSession, type Event, type LiveConnect } from "../src/session.js";
import { waitFor } from "./helpers.js";

const quiet = { log() {}, error() {} };

function fakeLive() {
  const params: LiveConnectParameters[] = [];
  const responses: unknown[] = [];
  let closed = 0;
  const connect: LiveConnect = async (p) => {
    params.push(p);
    return {
      sendRealtimeInput() {},
      sendClientContent() {},
      sendToolResponse: (r) => void responses.push(r),
      close: () => void closed++,
    };
  };
  return { connect, params, responses, get closed() { return closed; } };
}

function toolNames(p: LiveConnectParameters): string[] {
  return (p.config!.tools as any[])[0].functionDeclarations.map((d: any) => d.name);
}

test("a session snapshots the registry at open; later tools reach only the next session", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "first", description: "", handler: () => ({}) });
  const live = fakeLive();
  const s1 = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet });
  await s1.open();
  r.add("a", { name: "second", description: "", handler: () => ({}) });
  const s2 = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet });
  await s2.open();
  assert.deepEqual(toolNames(live.params[0]), ["first"]);
  assert.deepEqual(toolNames(live.params[1]), ["first", "second"]);
});

test("a tool result with endConversation closes after the turn and suppresses interrupted", async () => {
  const r = new ToolRegistry(quiet);
  r.add("x", { name: "bye", description: "", scheduling: "SILENT", handler: ({ reason }: { reason?: string }) => ({ ending: true, endConversation: reason ?? "done" }) });
  const live = fakeLive();
  const events: Event[] = [];
  const s = new GeminiSession((e) => events.push(e), r, { connect: live.connect, log: quiet });
  await s.open();
  s.handle({ toolCall: { functionCalls: [{ id: "1", name: "bye", args: { reason: "user said goodbye" } }] } } as LiveServerMessage);
  await waitFor(() => live.responses.length === 1);
  assert.deepEqual(live.responses[0], { functionResponses: [{ id: "1", name: "bye", response: { ending: true, scheduling: "SILENT" } }] });
  s.handle({ serverContent: { interrupted: true, turnComplete: true } } as LiveServerMessage);
  assert.ok(!events.some((e) => e.kind === "interrupted"));
  assert.deepEqual(events.at(-1), { kind: "closed", data: "ended: user said goodbye" });
  assert.equal(live.closed, 1);
});

test("without endConversation the turn completes normally", async () => {
  const r = new ToolRegistry(quiet);
  r.add("x", { name: "t", description: "", handler: () => ({ ok: 1 }) });
  const live = fakeLive();
  const events: Event[] = [];
  const s = new GeminiSession((e) => events.push(e), r, { connect: live.connect, log: quiet });
  await s.open();
  s.handle({ toolCall: { functionCalls: [{ id: "1", name: "t" }] } } as LiveServerMessage);
  await waitFor(() => live.responses.length === 1);
  s.handle({ serverContent: { interrupted: true } } as LiveServerMessage);
  assert.ok(events.some((e) => e.kind === "interrupted"));
  assert.ok(!events.some((e) => e.kind === "closed"));
  s.close();
});
