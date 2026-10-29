import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveConnectParameters } from "@google/genai";
import { ToolRegistry } from "@friday/sdk";
import { ChatEngine } from "../src/chat/engine.js";
import { GeminiSession, type LiveConnect } from "../src/session.js";
import { setup } from "./conversation-fixtures.js";
import { fakeStream, text } from "./fake-stream.js";

const quiet = { log() {}, warn() {}, error() {} };
const owner = { id: "u1", name: "Raymond" };
const member = { id: "u2", name: "Sanne" };

/** A registry as server.ts builds it: `u1` is the household owner, and the calendar is theirs only. */
function registry() {
  const r = new ToolRegistry(quiet);
  r.setOwnerCheck((u) => u?.id === owner.id);
  r.add("calendar", { name: "calendar_list_events", description: "", ownerOnly: true, handler: () => ({ events: [] }) });
  r.add("builtin", { name: "get_current_time", description: "", handler: () => ({ now: "10:00" }) });
  return r;
}

test("a member's chat turn doesn't offer an owner-only tool; the owner's does", async () => {
  const s = setup();
  const f = fakeStream({ chunks: [text("ok")] });
  const engine = new ChatEngine({ store: s.store, registry: registry(), llm: f.llm, model: "m", system: () => "P", toolTimeoutMs: 1000, log: quiet });
  for (const user of [member, owner]) {
    const r = engine.begin({ text: "what's on my calendar today?" }, { ...user, role: "member" });
    assert.ok(r.ok);
    await r.turn.run(() => {});
  }
  const offered = f.requests.map((req) => (req.tools ?? []).map((d) => d.name));
  assert.deepEqual(offered, [["get_current_time"], ["calendar_list_events", "get_current_time"]]);
});

function fakeLive() {
  const params: LiveConnectParameters[] = [];
  const connect: LiveConnect = async (p) => {
    params.push(p);
    return { sendRealtimeInput() {}, sendClientContent() {}, sendToolResponse() {}, close() {} };
  };
  return { connect, params };
}

const toolNames = (p: LiveConnectParameters): string[] => (p.config!.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((d) => d.name);

test("a member's Talk session doesn't offer an owner-only tool; the owner's device session does", async () => {
  const r = registry();
  const live = fakeLive();
  const talk = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => "k", user: member });
  const kitchen = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => "k", device: "friday-kitchen", user: owner });
  const nobody = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => "k", device: "friday-kitchen" });
  for (const s of [talk, kitchen, nobody]) await s.open();
  assert.deepEqual(live.params.map(toolNames), [["get_current_time"], ["calendar_list_events", "get_current_time"], ["get_current_time"]]);
  for (const s of [talk, kitchen, nobody]) s.close();
});
