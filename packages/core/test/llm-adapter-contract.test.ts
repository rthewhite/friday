/**
 * One contract, both adapters (llm-adapters): the same cases run against the Gemini adapter and the
 * OpenAI-compatible adapter, each over scripted raw provider responses (test/adapter-harness.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, type LlmErrorKind } from "@friday/sdk";
import { LlmService } from "../src/llm/service.js";
import type { ChatMessage, ChatModel, ChatRequest, ModelEnd, StreamChunk } from "../src/llm/types.js";
import { harnesses } from "./adapter-harness.js";

async function drain(it: AsyncGenerator<StreamChunk, ModelEnd>) {
  const chunks: StreamChunk[] = [];
  for (;;) {
    const r = await it.next();
    if (r.done) return { chunks, end: r.value };
    chunks.push(r.value);
  }
}

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", system: "sys", messages: [{ role: "user", text: "go" }], tools: [{ name: "a", description: "A." }, { name: "b", description: "B." }], ...o });
const kind = (k: LlmErrorKind, re?: RegExp) => (e: unknown) => e instanceof LlmError && e.kind === k && (!re || re.test(e.message));

function service(model: ChatModel) {
  const lines: string[] = [];
  const waits: number[] = [];
  const s = new LlmService({ model, models: { standard: "m", fast: "m" }, concurrency: 1, timeoutMs: 1000, retryDelaysMs: [5, 20], sleep: async (ms) => void waits.push(ms), log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) } });
  return { s, lines, waits };
}

for (const h of harnesses) {
  test(`${h.name}: text streams in order and ends as one assistant message`, async () => {
    const { model } = h.make({ text: ["It is ", "ten."] });
    const { chunks, end } = await drain(model.stream(req()));
    assert.deepEqual(chunks, [{ kind: "text", text: "It is " }, { kind: "text", text: "ten." }]);
    assert.equal(end.finish, "stop");
    assert.equal(end.message.text, "It is ten.");
    assert.equal(end.message.toolCalls, undefined);
  });

  test(`${h.name}: thoughts never appear unasked, and never in the answer`, async () => {
    const script = { thoughts: ["Let me think"], text: ["42"] };
    const unasked = await drain(h.make(script).model.stream(req()));
    assert.ok(!unasked.chunks.some((c) => c.kind === "thought"));
    const asked = await drain(h.make(script).model.stream(req({ thoughts: true })));
    assert.equal(asked.chunks.some((c) => c.kind === "thought"), h.thoughts);
    assert.equal(asked.end.message.text, "42");
  });

  test(`${h.name}: a tool round trip pairs the result with its call`, async () => {
    const { model, sent } = h.make({ calls: [{ id: "x1", name: "a", args: { n: 1 } }] }, { text: ["Done."] });
    const first = req();
    const r1 = await drain(model.stream(first));
    assert.deepEqual(r1.chunks, [{ kind: "call", call: { id: "x1", name: "a", args: { n: 1 } } }]);
    const results: ChatMessage[] = r1.end.message.toolCalls!.map((c) => ({ role: "tool", callId: c.id, name: c.name, result: { ok: c.name } }));
    const r2 = await drain(model.stream({ ...first, messages: [...first.messages, r1.end.message, ...results] }));
    assert.equal(r2.end.message.text, "Done.");
    assert.deepEqual(h.results(sent[1]), [{ callId: "x1", name: "a", result: { ok: "a" } }]);
  });

  test(`${h.name}: parallel calls keep their own ids, and each result goes back with its call`, async () => {
    const { model, sent } = h.make({ calls: [{ id: "p1", name: "a", args: {} }, { id: "p2", name: "b", args: { q: "Dune" } }] }, { text: ["ok"] });
    const r1 = await drain(model.stream(req()));
    const calls = r1.end.message.toolCalls!;
    assert.deepEqual(calls.map((c) => [c.id, c.name]), [["p1", "a"], ["p2", "b"]]);
    const results: ChatMessage[] = calls.map((c) => ({ role: "tool", callId: c.id, name: c.name, result: { from: c.name } }));
    await drain(model.stream({ ...req(), messages: [...req().messages, r1.end.message, ...results] }));
    assert.deepEqual(h.results(sent[1]), [
      { callId: "p1", name: "a", result: { from: "a" } },
      { callId: "p2", name: "b", result: { from: "b" } },
    ]);
  });

  test(`${h.name}: finish reasons: cut off is length, an unreadable call is malformed_call, a block rejects`, async () => {
    assert.equal((await drain(h.make({ text: ["Half"], finish: "length" }).model.stream(req()))).end.finish, "length");
    const malformed = await drain(h.make({ calls: [{ id: "m1", name: "a", args: { x: 1 } }], finish: "malformed" }).model.stream(req()));
    assert.equal(malformed.end.finish, "malformed_call");
    if (h.name === "openai") assert.equal(malformed.end.message.toolCalls, undefined);
    await assert.rejects(drain(h.make({ text: ["Well"], finish: "blocked" }).model.stream(req())), kind("blocked"));
  });

  test(`${h.name}: usage as reported, and zeros when none is`, async () => {
    assert.deepEqual((await drain(h.make({ text: ["x"], usage: { input: 30, output: 4 } }).model.stream(req()))).end.usage, { inputTokens: 30, outputTokens: 4, thoughtTokens: 0 });
    assert.deepEqual((await drain(h.make({ text: ["x"], usage: null }).model.stream(req()))).end.usage, { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 });
  });

  test(`${h.name}: a 429 with a stated wait is retried after it; 503 and network are retried`, async () => {
    const limited = h.make({ fail: "429", waitS: 3 }, { text: ["ok"] });
    const a = service(limited.model);
    await a.s.streamCall("chat", req(), () => {});
    assert.ok(a.waits[0] >= 3000 && a.waits[0] <= 3300, String(a.waits[0]));
    assert.match(a.lines[0], /ok .*\(2 attempts: 429 wait 3\.\ds\)$/);

    const flaky = h.make({ fail: "503" }, { fail: "network" }, { text: ["ok"] });
    const b = service(flaky.model);
    assert.equal((await b.s.forOwner("brain").generate({ prompt: "p" })).text, "ok");
    assert.match(b.lines[0], /\(3 attempts: 503 wait \d+\.\ds, network wait \d+\.\ds\)$/);
  });

  test(`${h.name}: 401 is unavailable after one attempt`, async () => {
    const denied = h.make({ fail: "401" });
    const c = service(denied.model);
    await assert.rejects(c.s.forOwner("brain").generate({ prompt: "p" }), kind("unavailable", /HTTP 401/));
    assert.equal(denied.sent.length, 1);
  });

  test(`${h.name}: a schema request sends the schema and resolves with validated json`, async () => {
    const schema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };
    const { model, sent } = h.make({ text: ['{"facts":["a"]}'] });
    const r = await service(model).s.forOwner("brain").generate<{ facts: string[] }>({ prompt: "p", schema });
    assert.deepEqual(r.json, { facts: ["a"] });
    assert.deepEqual(h.schema(sent[0]), schema);
  });
}
