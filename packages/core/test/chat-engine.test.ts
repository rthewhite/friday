import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, ToolRegistry, type ConversationEntry } from "@friday/sdk";
import { ChatEngine, MAX_TOOL_ROUNDS, type ChatEvent } from "../src/chat/engine.js";
import type { StreamChunk, StreamEnd } from "../src/llm/gemini.js";
import type { StreamCallRequest } from "../src/llm/service.js";
import { setup } from "./conversation-fixtures.js";
import { prompts } from "../src/config.js";
import { createPromptContext, systemPrompt } from "../src/prompt-context.js";

const quiet = { log() {}, warn() {}, error() {} };
const end: StreamEnd = { finishReason: "STOP", model: "m", usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } };
const text = (t: string, extra: object = {}): StreamChunk => ({ kind: "text", text: t, part: { text: t, ...extra } });
const thought = (t: string): StreamChunk => ({ kind: "thought", text: t, part: { text: t, thought: true } });
const call = (name: string, args: Record<string, unknown> = {}, sig?: string): StreamChunk => ({
  kind: "call", name, args, part: { functionCall: { name, args }, ...(sig ? { thoughtSignature: sig } : {}) },
});

/** `{ finish }` sets the round's finish reason (default STOP). */
type Round = Array<StreamChunk | Error | { finish: string }> | Error;

/** A stand-in for LlmService.streamCall that plays one round per call (the last repeats) and snapshots each request. */
function fakeLlm(...rounds: Round[]) {
  const requests: StreamCallRequest[] = [];
  const owners: string[] = [];
  const llm = {
    async streamCall(owner: string, req: StreamCallRequest, onChunk: (c: StreamChunk) => void): Promise<StreamEnd> {
      owners.push(owner);
      requests.push(JSON.parse(JSON.stringify(req)));
      const round = rounds[Math.min(requests.length - 1, rounds.length - 1)];
      if (round instanceof Error) throw round;
      let finishReason = "STOP";
      for (const c of round) {
        if (c instanceof Error) throw c;
        if ("finish" in c) finishReason = c.finish;
        else onChunk(c);
      }
      return { ...end, finishReason };
    },
  };
  return { llm, requests, owners };
}

function engine(llm: ReturnType<typeof fakeLlm>["llm"], o: { registry?: ToolRegistry; toolTimeoutMs?: number; system?: () => string } = {}) {
  const s = setup();
  const registry = o.registry ?? new ToolRegistry(quiet);
  const e = new ChatEngine({ store: s.store, registry, llm, model: "chat-model", system: o.system ?? (() => "CHAT PROMPT"), toolTimeoutMs: o.toolTimeoutMs ?? 1000, log: quiet });
  return { ...s, registry, engine: e };
}

async function send(e: ChatEngine, text: string, conversationId?: string) {
  const r = e.begin({ text, conversationId });
  if (!r.ok) throw new Error(`begin failed: ${r.status} ${r.error}`);
  const events: ChatEvent[] = [];
  await r.turn.run((ev) => events.push(ev));
  return { id: r.turn.conversationId, events };
}

const shape = (entries: ConversationEntry[]) => entries.map(({ seq, at, ...rest }) => rest);
const kinds = (events: ChatEvent[]) => events.map((e) => e.event);

test("two tools, then an answer: events stream in order, contents carry verbatim parts, the turn is recorded", async () => {
  const f = fakeLlm(
    [thought("Planning"), call("ha_turn_off", { entity: "light.x" }, "sig-1")],
    [call("jellyfin_search", { q: "Dune" }, "sig-2")],
    [text("Done. "), text("Which Dune?")],
  );
  const { engine: e, registry, store } = engine(f.llm);
  registry.add("ha", { name: "ha_turn_off", description: "", handler: () => ({ ok: true }) });
  registry.add("media", { name: "jellyfin_search", description: "", handler: () => ({ items: 2, scheduling: "SILENT" }) });
  const { id, events } = await send(e, "turn off the light and find Dune");
  assert.deepEqual(events, [
    { event: "start", data: { conversationId: id } },
    { event: "thinking", data: { text: "Planning" } },
    { event: "tool_call", data: { id: 1, name: "ha_turn_off", args: { entity: "light.x" } } },
    { event: "tool_result", data: { id: 1, name: "ha_turn_off", result: { ok: true } } },
    { event: "tool_call", data: { id: 2, name: "jellyfin_search", args: { q: "Dune" } } },
    { event: "tool_result", data: { id: 2, name: "jellyfin_search", result: { items: 2 } } },
    { event: "text", data: { text: "Done. " } },
    { event: "text", data: { text: "Which Dune?" } },
    { event: "done", data: { conversationId: id } },
  ]);
  assert.deepEqual(f.owners, ["chat", "chat", "chat"]);
  assert.equal(f.requests[0].model, "chat-model");
  assert.equal(f.requests[0].system, "CHAT PROMPT");
  assert.equal(f.requests[0].thoughts, true);
  assert.deepEqual(f.requests[0].contents, [{ role: "user", parts: [{ text: "turn off the light and find Dune" }] }]);
  // Round 3 sees both rounds: model parts verbatim (signatures kept, the thought summary dropped), then the responses.
  assert.deepEqual(f.requests[2].contents.slice(1), [
    { role: "model", parts: [{ functionCall: { name: "ha_turn_off", args: { entity: "light.x" } }, thoughtSignature: "sig-1" }] },
    { role: "user", parts: [{ functionResponse: { name: "ha_turn_off", response: { ok: true } } }] },
    { role: "model", parts: [{ functionCall: { name: "jellyfin_search", args: { q: "Dune" } }, thoughtSignature: "sig-2" }] },
    { role: "user", parts: [{ functionResponse: { name: "jellyfin_search", response: { items: 2 } } }] },
  ]);
  const c = store.get(id)!;
  assert.equal(c.channel, "chat");
  assert.equal(c.device, null);
  assert.equal(c.state, "active", "a finished turn does not end the thread");
  assert.equal(store.isLive(id), false);
  assert.deepEqual(shape(c.entries), [
    { kind: "user", input: "text", text: "turn off the light and find Dune" },
    { kind: "tool", name: "ha_turn_off", args: { entity: "light.x" }, result: { ok: true }, truncated: false },
    { kind: "tool", name: "jellyfin_search", args: { q: "Dune" }, result: { items: 2 }, truncated: false },
    { kind: "assistant", text: "Done. Which Dune?", interrupted: false },
  ]);
});

test("a chat tool call carries channel chat and the thread's id, on a new and on a resumed thread", async () => {
  const f = fakeLlm([call("recall")], [text("Done.")], [call("recall")], [text("Again.")]);
  const { engine: e, registry } = engine(f.llm);
  const seen: unknown[] = [];
  registry.add("brain", { name: "recall", description: "", handler: (_args, c) => (seen.push(c), { ok: true }) });
  const first = await send(e, "what did we say about the boiler?");
  const second = await send(e, "and the heater?", first.id);
  assert.equal(second.id, first.id);
  assert.deepEqual(seen, [{ channel: "chat", conversationId: first.id }, { channel: "chat", conversationId: first.id }]);
});

test("parallel calls in one round run together and answer in call order", async () => {
  const f = fakeLlm([call("slow"), call("fast")], [text("ok")]);
  const { engine: e, registry } = engine(f.llm);
  const order: string[] = [];
  registry.add("x", { name: "slow", description: "", handler: async () => (await new Promise((r) => setTimeout(r, 20)), order.push("slow"), { n: 1 }) });
  registry.add("x", { name: "fast", description: "", handler: () => (order.push("fast"), { n: 2 }) });
  await send(e, "go");
  assert.deepEqual(order, ["fast", "slow"]);
  assert.deepEqual(f.requests[1].contents.at(-1), { role: "user", parts: [{ functionResponse: { name: "slow", response: { n: 1 } } }, { functionResponse: { name: "fast", response: { n: 2 } } }] });
});

test("a hanging tool is answered with a timeout error and the turn continues", async () => {
  const f = fakeLlm([call("hang")], [text("It timed out.")]);
  const { engine: e, registry, store } = engine(f.llm, { toolTimeoutMs: 20 });
  registry.add("x", { name: "hang", description: "", handler: () => new Promise(() => {}) });
  const { id, events } = await send(e, "try it");
  assert.deepEqual(events.find((ev) => ev.event === "tool_result"), { event: "tool_result", data: { id: 1, name: "hang", result: { error: "timed out after 20 ms" } } });
  assert.equal(events.at(-1)!.event, "done");
  assert.deepEqual(f.requests[1].contents.at(-1)!.parts, [{ functionResponse: { name: "hang", response: { error: "timed out after 20 ms" } } }]);
  assert.deepEqual((store.get(id)!.entries[1] as { result: unknown }).result, { error: "timed out after 20 ms" });
});

test("voice-only tools are not declared, and calling one is an unknown tool that closes nothing", async () => {
  const f = fakeLlm([call("end_conversation", { reason: "bye" })], [text("Bye!")]);
  const { engine: e, registry, store } = engine(f.llm);
  let ended = 0;
  registry.add("builtin", { name: "get_current_time", description: "", handler: () => ({}) });
  registry.add("builtin", { name: "end_conversation", description: "", channels: ["voice"], handler: () => (ended++, { ending: true, endConversation: "bye" }) });
  const { id, events } = await send(e, "bye");
  assert.deepEqual(f.requests[0].tools!.map((t) => t.name), ["get_current_time"]);
  assert.equal(ended, 0);
  assert.deepEqual(events.find((ev) => ev.event === "tool_result")!.data, { id: 1, name: "end_conversation", result: { error: "unknown tool end_conversation" } });
  assert.equal(events.at(-1)!.event, "done");
  assert.equal(store.get(id)!.state, "active");
});

test("endConversation from a tool offered in chat is ignored", async () => {
  const f = fakeLlm([call("wrap_up")], [text("ok")]);
  const { engine: e, registry, store } = engine(f.llm);
  registry.add("x", { name: "wrap_up", description: "", handler: () => ({ done: true, endConversation: "finished", scheduling: "SILENT" }) });
  const { id, events } = await send(e, "wrap up");
  assert.deepEqual(events.find((ev) => ev.event === "tool_result")!.data, { id: 1, name: "wrap_up", result: { done: true } });
  assert.equal(store.get(id)!.endReason, null);
  assert.equal(store.get(id)!.state, "active");
});

test(`after ${MAX_TOOL_ROUNDS} rounds of tool calls the next calls end the turn with too_many_tool_calls`, async () => {
  const f = fakeLlm([call("again")]);
  const { engine: e, registry, store } = engine(f.llm);
  let ran = 0;
  registry.add("x", { name: "again", description: "", handler: () => ({ n: ++ran }) });
  const { id, events } = await send(e, "loop");
  assert.equal(ran, MAX_TOOL_ROUNDS);
  assert.equal(f.requests.length, MAX_TOOL_ROUNDS + 1);
  const last = events.at(-1)!;
  assert.equal(last.event, "error");
  assert.equal((last.data as { kind: string }).kind, "too_many_tool_calls");
  // The announced 11th call is settled as not run, live and stored alike.
  const calls = events.filter((ev) => ev.event === "tool_call");
  const results = events.filter((ev) => ev.event === "tool_result");
  assert.equal(calls.length, MAX_TOOL_ROUNDS + 1);
  assert.equal(results.length, calls.length);
  assert.deepEqual(results.at(-1)!.data, { id: MAX_TOOL_ROUNDS + 1, name: "again", result: { error: `not run: more than ${MAX_TOOL_ROUNDS} rounds of tool calls` } });
  const tools = store.get(id)!.entries.filter((x) => x.kind === "tool");
  assert.equal(tools.length, MAX_TOOL_ROUNDS + 1);
});

test("parallel calls to the same tool carry ids, so results match their calls whatever order they settle in", async () => {
  const f = fakeLlm([call("weather", { city: "A" }), call("weather", { city: "B" })], [text("ok")]);
  const { engine: e, registry } = engine(f.llm);
  registry.add("x", {
    name: "weather",
    description: "",
    handler: async ({ city }: { city: string }) => (city === "A" && (await new Promise((r) => setTimeout(r, 20))), { city }),
  });
  const { events } = await send(e, "weather in A and B");
  const tools = events.filter((ev) => ev.event === "tool_call" || ev.event === "tool_result").map((ev) => ev.data);
  assert.deepEqual(tools, [
    { id: 1, name: "weather", args: { city: "A" } },
    { id: 2, name: "weather", args: { city: "B" } },
    { id: 2, name: "weather", result: { city: "B" } },
    { id: 1, name: "weather", result: { city: "A" } },
  ]);
});

test("a round that ends unfinished without calls is an error, not an empty done", async () => {
  const cut = fakeLlm([text("Here is a long"), { finish: "MAX_TOKENS" }]);
  const a = engine(cut.llm);
  const r1 = await send(a.engine, "write a lot");
  assert.deepEqual(r1.events.at(-1), { event: "error", data: { kind: "invalid_output", message: "the answer was cut off at the output limit" } });
  assert.deepEqual(shape(a.store.get(r1.id)!.entries).at(-1), { kind: "assistant", text: "Here is a long", interrupted: true });

  const malformed = fakeLlm([{ finish: "MALFORMED_FUNCTION_CALL" }]);
  const b = engine(malformed.llm);
  const r2 = await send(b.engine, "do it");
  assert.deepEqual(r2.events.map((ev) => ev.event), ["start", "error"]);
  assert.equal((r2.events[1].data as { message: string }).message, "the model produced a malformed tool call");
  assert.deepEqual(shape(b.store.get(r2.id)!.entries), [{ kind: "user", input: "text", text: "do it" }]);
});

test("begin answers 503 when a resumed thread's message could not be stored, and runs no turn", async () => {
  const f = fakeLlm([text("hi")]);
  const { engine: e, store } = engine(f.llm);
  const { id } = await send(e, "first");
  const append = store.append.bind(store);
  store.append = () => {
    throw new Error("SQLITE_FULL");
  };
  assert.deepEqual(e.begin({ text: "second", conversationId: id }), { ok: false, status: 503, error: "the message could not be stored" });
  assert.equal(store.isLive(id), false);
  store.append = append;
  assert.equal(f.requests.length, 1);
  assert.equal(store.get(id)!.entryCount, 2);
});

test("a failure after streamed text stores it as interrupted and ends with an error event", async () => {
  const f = fakeLlm([text("Dune is"), new LlmError("unavailable", "model unreachable: fetch failed")]);
  const { engine: e, store } = engine(f.llm);
  const { id, events } = await send(e, "tell me about Dune");
  assert.deepEqual(kinds(events), ["start", "text", "error"]);
  assert.deepEqual(events.at(-1)!.data, { kind: "unavailable", message: "model unreachable: fetch failed" });
  assert.deepEqual(shape(store.get(id)!.entries), [
    { kind: "user", input: "text", text: "tell me about Dune" },
    { kind: "assistant", text: "Dune is", interrupted: true },
  ]);
  assert.equal(store.isLive(id), false);
});

test("a missing key: start, then error unavailable, and the message is stored", async () => {
  const f = fakeLlm(new LlmError("unavailable", "GEMINI_API_KEY is not configured"));
  const { engine: e, store } = engine(f.llm);
  const { id, events } = await send(e, "hello");
  assert.deepEqual(events, [
    { event: "start", data: { conversationId: id } },
    { event: "error", data: { kind: "unavailable", message: "GEMINI_API_KEY is not configured" } },
  ]);
  assert.deepEqual(shape(store.get(id)!.entries), [{ kind: "user", input: "text", text: "hello" }]);
});

test("begin: empty text is 400, unknown or voice ids are 404, a running turn is 409, and nothing is recorded for them", async () => {
  const f = fakeLlm([text("hi")]);
  const { engine: e, store } = engine(f.llm);
  assert.deepEqual(e.begin({ text: "   " }), { ok: false, status: 400, error: "text is required" });
  assert.equal(e.begin({}).ok, false);
  assert.deepEqual(e.begin({ text: "x", conversationId: 5 }), { ok: false, status: 400, error: "conversationId must be a string" });
  assert.deepEqual(e.begin({ text: "x", conversationId: "nope" }), { ok: false, status: 404, error: "unknown chat conversation" });
  const voice = store.create({ channel: "voice" });
  assert.deepEqual(e.begin({ text: "x", conversationId: voice }), { ok: false, status: 404, error: "unknown chat conversation" });
  assert.equal(store.get(voice)!.entryCount, 0);

  const first = e.begin({ text: "first" });
  assert.ok(first.ok);
  const busy = e.begin({ text: "second", conversationId: first.turn.conversationId });
  assert.deepEqual(busy, { ok: false, status: 409, error: "a turn is still running in this conversation" });
  await first.turn.run(() => {});
  assert.equal(store.get(first.turn.conversationId)!.entryCount, 2);
  assert.ok(e.begin({ text: "second", conversationId: first.turn.conversationId }).ok, "free again once the turn ended");
});

test("a resumed thread replays its whole history, tools included, and reads tools fresh per turn", async () => {
  const f = fakeLlm([call("ha_get_state", { entity: "light.x" })], [text("It is on.")], [text("Turned off.")]);
  const { engine: e, registry, store } = engine(f.llm);
  registry.add("ha", { name: "ha_get_state", description: "", handler: () => ({ state: "on" }) });
  const { id } = await send(e, "is the light on?");
  registry.add("ha", { name: "ha_turn_off", description: "", handler: () => ({ ok: true }) });
  const again = await send(e, "turn it off", id);
  assert.equal(again.id, id);
  assert.deepEqual(f.requests[2].tools!.map((t) => t.name), ["ha_get_state", "ha_turn_off"]);
  assert.deepEqual(f.requests[2].contents, [
    { role: "user", parts: [{ text: "is the light on?" }] },
    { role: "model", parts: [{ functionCall: { name: "ha_get_state", args: { entity: "light.x" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "ha_get_state", response: { state: "on" } } }] },
    { role: "model", parts: [{ text: "It is on." }] },
    { role: "user", parts: [{ text: "turn it off" }] },
  ]);
  assert.deepEqual(store.get(id)!.entries.map((x) => x.seq), [1, 2, 3, 4, 5]);
});

test("a throwing listener does not stop the turn", async () => {
  const f = fakeLlm([text("still recorded")]);
  const { engine: e, store } = engine(f.llm);
  const r = e.begin({ text: "hi" });
  assert.ok(r.ok);
  await r.turn.run(() => {
    throw new Error("socket gone");
  });
  assert.deepEqual(shape(store.get(r.turn.conversationId)!.entries).at(-1), { kind: "assistant", text: "still recorded", interrupted: false });
});

test("module context is rendered once per turn, used on every call of the tool loop, and fresh on the next turn", async () => {
  const context = createPromptContext({ log: quiet });
  let renders = 0;
  let fact = "The user likes Dune.";
  context.forOwner("brain").addContext(({ channel }) => {
    renders++;
    return channel === "chat" ? `## Brain\n${fact}` : "voice only";
  });
  const f = fakeLlm([call("lookup")], [call("lookup")], [text("Done.")], [text("Again.")]);
  const { engine: e, registry } = engine(f.llm, { system: systemPrompt(context, "chat") });
  registry.add("brain", { name: "lookup", description: "", handler: () => {
    // Changing mid-turn must not reach this turn's later calls.
    fact = "The user likes Dune and Arrival.";
    return { ok: true };
  } });
  const first = await send(e, "what do I like?");
  const expected = (f: string) => `${prompts.base}\n\n${prompts.chat}\n\n## Brain\n${f}`;
  assert.deepEqual(f.requests.map((r) => r.system), [expected("The user likes Dune."), expected("The user likes Dune."), expected("The user likes Dune.")]);
  assert.equal(renders, 1);
  await send(e, "and now?", first.id);
  assert.equal(f.requests[3].system, expected("The user likes Dune and Arrival."));
  assert.equal(renders, 2);
});
