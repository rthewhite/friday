import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "@friday/sdk";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai";
import { GeminiSession, type Event, type LiveConnect } from "../src/session.js";
import { waitFor } from "./helpers.js";
import { setup } from "./conversation-fixtures.js";
import { prompts, settings } from "../src/config.js";
import { createPromptContext, systemPrompt } from "../src/prompt-context.js";

const quiet = { log() {}, error() {} };

function fakeLive() {
  const params: LiveConnectParameters[] = [];
  const keys: string[] = [];
  const responses: unknown[] = [];
  let closed = 0;
  const connect: LiveConnect = async (p, apiKey) => {
    params.push(p);
    keys.push(apiKey);
    return {
      sendRealtimeInput() {},
      sendClientContent() {},
      sendToolResponse: (r) => void responses.push(r),
      close: () => void closed++,
    };
  };
  return { connect, params, keys, responses, get closed() { return closed; } };
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

test("a session declares and calls only tools offered in voice", async () => {
  const r = new ToolRegistry(quiet);
  r.add("a", { name: "both", description: "", handler: () => ({}) });
  r.add("a", { name: "spoken", description: "", channels: ["voice"], handler: () => ({}) });
  r.add("a", { name: "typed", description: "", channels: ["chat"], handler: () => ({ ran: true }) });
  const live = fakeLive();
  const s = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet });
  await s.open();
  assert.deepEqual(toolNames(live.params[0]), ["both", "spoken"]);
  s.handle({ toolCall: { functionCalls: [{ id: "1", name: "typed", args: {} }] } } as LiveServerMessage);
  await waitFor(() => live.responses.length === 1);
  assert.deepEqual(live.responses[0], { functionResponses: [{ id: "1", name: "typed", response: { error: "unknown tool typed", scheduling: "INTERRUPT" } }] });
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

const msg = (serverContent: LiveServerMessage["serverContent"]) => ({ serverContent }) as LiveServerMessage;

test("typed text is recorded as input text, followed by the answer", async () => {
  const { store } = setup();
  const recorder = store.recorder({ channel: "voice" });
  const live = fakeLive();
  const s = new GeminiSession(() => {}, new ToolRegistry(quiet), { connect: live.connect, log: quiet, recorder });
  await s.open();
  s.sendText("what time is it");
  s.handle(msg({ outputTranscription: { text: "It's" } }));
  s.handle(msg({ outputTranscription: { text: " noon." }, turnComplete: true }));
  s.close();
  const c = store.get(recorder.conversationId!)!;
  assert.deepEqual(c.entries.map(({ seq, at, ...e }) => e), [
    { kind: "user", input: "text", text: "what time is it" },
    { kind: "assistant", text: "It's noon.", interrupted: false },
  ]);
  assert.equal(c.endReason, "client closed");
});

test("end_conversation ends the recorded conversation quiet with reason ended: done", async () => {
  const { store } = setup();
  const recorder = store.recorder({ channel: "voice" });
  const r = new ToolRegistry(quiet);
  r.add("builtin", { name: "end_conversation", description: "", scheduling: "SILENT", handler: ({ reason }: { reason?: string }) => ({ ending: true, endConversation: reason ?? "done" }) });
  const live = fakeLive();
  const s = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, recorder });
  await s.open();
  s.handle(msg({ inputTranscription: { text: " Thanks, bye." } }));
  s.handle({ toolCall: { functionCalls: [{ id: "1", name: "end_conversation", args: {} }] } } as LiveServerMessage);
  await waitFor(() => live.responses.length === 1);
  s.handle(msg({ outputTranscription: { text: "Bye!" } }));
  s.handle(msg({ interrupted: true, turnComplete: true }));
  const c = store.get(recorder.conversationId!)!;
  assert.equal(c.state, "quiet");
  assert.equal(c.endReason, "ended: done");
  assert.deepEqual(c.entries.map((e) => e.kind), ["user", "tool", "assistant"]);
  assert.deepEqual(c.entries[1], { seq: 2, at: c.entries[1].at, kind: "tool", name: "end_conversation", args: {}, result: { ending: true }, truncated: false });
  assert.equal(c.entries[2].kind === "assistant" && c.entries[2].interrupted, false, "the suppressed interruption is not recorded");
});

test("a session emits exactly the same events with and without a recorder", async () => {
  const run = async (withRecorder: boolean) => {
    const { store } = setup();
    const r = new ToolRegistry(quiet);
    r.add("x", { name: "t", description: "", handler: ({ n }: { n: number }) => ({ n }) });
    const live = fakeLive();
    const events: Event[] = [];
    const recorder = withRecorder ? store.recorder({ channel: "voice", device: "kitchen" }) : undefined;
    const s = new GeminiSession((e) => events.push(e), r, { connect: live.connect, log: quiet, recorder });
    await s.open();
    s.handle(msg({ inputTranscription: { text: " Do" } }));
    s.handle(msg({ inputTranscription: { text: " it." } }));
    s.handle({ toolCall: { functionCalls: [{ id: "1", name: "t", args: { n: 1 } }, { id: "2", name: "t", args: { n: 2 } }] } } as LiveServerMessage);
    await waitFor(() => live.responses.length === 2);
    s.handle(msg({ outputTranscription: { text: "Done" }, modelTurn: { parts: [{ inlineData: { data: Buffer.from([1, 2]).toString("base64") } }] } }));
    s.handle(msg({ inputTranscription: { text: " wait" } }));
    s.handle(msg({ interrupted: true }));
    s.handle(msg({ turnComplete: true }));
    s.close();
    return { events, entries: recorder ? store.get(recorder.conversationId!)!.entries.length : 0 };
  };
  const plain = await run(false);
  const recorded = await run(true);
  assert.deepEqual(recorded.events, plain.events);
  assert.equal(recorded.entries, 5);
});

test("the Gemini key is resolved when a session opens; a later change reaches only the next session", async () => {
  const live = fakeLive();
  let key = "key-one";
  const r = new ToolRegistry(quiet);
  const s1 = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => key });
  await s1.open();
  key = "key-two";
  const s2 = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => key });
  await s2.open();
  assert.deepEqual(live.keys, ["key-one", "key-two"]);
  s1.close();
  s2.close();
});

test("the system instruction is base + voice + module context, built when each session opens", async () => {
  const context = createPromptContext({ log: { ...quiet, warn() {} } });
  const live = fakeLive();
  const open = async () => {
    const s = new GeminiSession(() => {}, new ToolRegistry(quiet), { connect: live.connect, log: quiet, systemPrompt: systemPrompt(context, "voice") });
    await s.open();
    return s;
  };
  let known = "The user is Ray.";
  context.forOwner("brain").addContext(({ channel }) => (channel === "voice" ? `## Brain\n${known}` : "chat only"));
  const s1 = await open();
  known = "The user is Ray and has a dog.";
  // The open session keeps its instruction; only the next one sees the change.
  const s2 = await open();
  const instructions = live.params.map((p) => p.config!.systemInstruction);
  assert.deepEqual(instructions, [
    `${prompts.base}\n\n${prompts.voice}\n\n## Brain\nThe user is Ray.`,
    `${prompts.base}\n\n${prompts.voice}\n\n## Brain\nThe user is Ray and has a dog.`,
  ]);
  s1.close();
  s2.close();
});

test("without module context the instruction is the base and voice parts only", async () => {
  const context = createPromptContext({ log: { ...quiet, warn() {} } });
  context.forOwner("brain").addContext(() => undefined);
  context.forOwner("media").addContext(() => { throw new Error("broken"); });
  const live = fakeLive();
  const s = new GeminiSession(() => {}, new ToolRegistry(quiet), { connect: live.connect, log: quiet, systemPrompt: systemPrompt(context, "voice") });
  await s.open();
  const plain = new GeminiSession(() => {}, new ToolRegistry(quiet), { connect: live.connect, log: quiet });
  await plain.open();
  assert.equal(live.params[0].config!.systemInstruction, `${prompts.base}\n\n${prompts.voice}`);
  assert.equal(live.params[1].config!.systemInstruction, settings.systemPrompt);
  s.close();
  plain.close();
});
