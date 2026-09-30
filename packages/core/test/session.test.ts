import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "@friday/sdk";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai";
import { GeminiSession, endsWithQuestion, type Event, type LiveConnect } from "../src/session.js";
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

test("endsWithQuestion looks at the last character past closing quotes, brackets and whitespace", () => {
  for (const t of ["What would you like to share?", 'She asked "ready?"', "(anything else?) ", "准备好了吗？", "هل أنت مستعد؟", "Klaar?”\n"]) {
    assert.equal(endsWithQuestion(t), true, t);
  }
  for (const t of ["Want the lights on? Done, they're on.", "Goodbye!", "", "   ", "?!"]) {
    assert.equal(endsWithQuestion(t), false, t);
  }
});

/** A session with a SILENT tool that asks to end, and a short idle timeout. */
async function endingSession(idleTimeoutMs = 20) {
  const r = new ToolRegistry(quiet);
  r.add("builtin", { name: "end_conversation", description: "", scheduling: "SILENT", handler: ({ reason }: { reason?: string }) => ({ ending: true, endConversation: reason ?? "done" }) });
  const live = fakeLive();
  const events: Event[] = [];
  const logs: string[] = [];
  const s = new GeminiSession((e) => events.push(e), r, { connect: live.connect, log: { log: (m: string) => void logs.push(m), error() {} } });
  await s.open();
  const previous = settings.idleTimeoutMs;
  settings.idleTimeoutMs = idleTimeoutMs;
  const restore = () => {
    settings.idleTimeoutMs = previous;
    s.close();
  };
  /** One model turn: its spoken words, optionally an end request, then turnComplete. */
  const turn = async (text: string, end?: string) => {
    s.handle(msg({ outputTranscription: { text } }));
    if (end !== undefined) {
      const n = live.responses.length;
      s.handle({ toolCall: { functionCalls: [{ id: String(n), name: "end_conversation", args: { reason: end } }] } } as LiveServerMessage);
      await waitFor(() => live.responses.length === n + 1);
    }
    s.handle(msg({ turnComplete: true }));
  };
  return { s, r, live, events, logs, turn, restore };
}

const closedWith = (events: Event[]) => events.filter((e) => e.kind === "closed").map((e) => (e as { data?: string }).data);

test("an end requested in a turn that ends with a question keeps the session open and arms the idle timer", async () => {
  const t = await endingSession(60_000);
  try {
    // Conversation c1e1a36e: Friday asked a question and ended in the same turn.
    t.s.handle(msg({ outputTranscription: { text: "Good morning! I'd love to learn more about your life. " } }));
    await t.turn("What would you like to share with me today?", "request done");
    assert.deepEqual(closedWith(t.events), []);
    assert.equal(t.live.closed, 0);
    assert.ok(t.logs.includes("gemini: end requested after a question, keeping the session open"));
    assert.ok((t.s as any).idleTimer, "idle timer armed");
  } finally {
    t.restore();
  }
});

test("a question before a closing quote, or with a full-width or Arabic mark, also keeps the session open", async () => {
  for (const words of ['You said "which room?" ', "还有别的吗？", "هل هناك شيء آخر؟"]) {
    const t = await endingSession(60_000);
    try {
      await t.turn(words, "request done");
      assert.deepEqual(closedWith(t.events), [], words);
    } finally {
      t.restore();
    }
  }
});

test("speech cancels the idle timer", async () => {
  const t = await endingSession();
  try {
    await t.turn("Lights are on.");
    t.s.handle(msg({ inputTranscription: { text: "And the kitchen" } }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(closedWith(t.events), []);
  } finally {
    t.restore();
  }
});

test("the idle timer is not armed while a tool is still running", async () => {
  const t = await endingSession();
  let finish!: () => void;
  t.r.add("x", { name: "slow", description: "", handler: () => new Promise((done) => (finish = () => done({ ok: true }))) });
  try {
    t.s.handle({ toolCall: { functionCalls: [{ id: "slow", name: "slow", args: {} }] } } as LiveServerMessage);
    await t.turn("Timer set.");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(closedWith(t.events), []);
  } finally {
    finish?.();
    t.restore();
  }
});

test("silence after a dropped end closes with ended: no follow-up (end after question)", async () => {
  const t = await endingSession();
  try {
    await t.turn("What would you like to share with me today?", "request done");
    await waitFor(() => t.events.some((e) => e.kind === "closed"));
    assert.deepEqual(closedWith(t.events), ["ended: no follow-up (end after question)"]);
    assert.equal(t.live.closed, 1);
  } finally {
    t.restore();
  }
});

test("after a dropped end the user can answer, and the next turn neither ends nor carries the question reason", async () => {
  const t = await endingSession(60_000);
  try {
    await t.turn("Anything else?", "request done");
    t.s.handle(msg({ inputTranscription: { text: "Yes, my daughter's birthday is in May." } }));
    await t.turn("Noted, I'll remember that.");
    assert.deepEqual(closedWith(t.events), []);
    settings.idleTimeoutMs = 20;
    await t.turn("Anything more?");
    await waitFor(() => t.events.some((e) => e.kind === "closed"));
    assert.deepEqual(closedWith(t.events), ["ended: no follow-up"]);
  } finally {
    t.restore();
  }
});

test("an end after a statement, or after a question in the middle of the turn, still closes right away", async () => {
  for (const words of ["Done.", "Want the lights on? Done, they're on."]) {
    const t = await endingSession(60_000);
    try {
      await t.turn(words, "request done");
      assert.deepEqual(closedWith(t.events), ["ended: request done"], words);
    } finally {
      t.restore();
    }
  }
});

test("a dropped end with the idle timeout disabled leaves the session open", async () => {
  const t = await endingSession(0);
  try {
    await t.turn("Which room?", "request done");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(closedWith(t.events), []);
  } finally {
    t.restore();
  }
});

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

test("a voice tool call carries the conversation id once the conversation is stored, and none in the first exchange", async () => {
  const { store } = setup();
  const recorder = store.recorder({ channel: "voice" });
  const r = new ToolRegistry(quiet);
  const seen: unknown[] = [];
  r.add("brain", { name: "recall", description: "", handler: (_args, call) => (seen.push(call), { ok: true }) });
  const live = fakeLive();
  const s = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, recorder });
  await s.open();
  s.handle(msg({ inputTranscription: { text: "what did we say about the boiler?" } }));
  s.handle({ toolCall: { functionCalls: [{ id: "1", name: "recall", args: {} }] } } as LiveServerMessage);
  await waitFor(() => live.responses.length === 1);
  s.handle(msg({ outputTranscription: { text: "Nothing yet." }, turnComplete: true }));
  const id = recorder.conversationId;
  assert.ok(id, "the first exchange is stored at its turn end");
  s.handle(msg({ inputTranscription: { text: "and the heater?" } }));
  s.handle({ toolCall: { functionCalls: [{ id: "2", name: "recall", args: {} }] } } as LiveServerMessage);
  await waitFor(() => live.responses.length === 2);
  assert.deepEqual(seen, [{ channel: "voice" }, { channel: "voice", conversationId: id }]);
  s.close();
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
