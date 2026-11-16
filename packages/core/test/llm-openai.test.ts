/** The OpenAI-compatible adapter: schema conversion, SSE parsing, requests, streaming and failures (llm-adapters). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, Type, type LlmErrorKind } from "@friday/sdk";
import { OpenAICompatibleAdapter, retryAfterMs, sseData, toJsonSchema } from "../src/llm/openai.js";
import { LlmService } from "../src/llm/service.js";
import type { ChatRequest, ModelEnd, StreamChunk } from "../src/llm/types.js";

// --- Fakes ---------------------------------------------------------------------------------------------

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
}

type Reply = Response | Error | (() => Response);

/** A `fetch` that answers each call with the next reply (the last repeats) and records what was sent. */
export function fakeFetch(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    sent.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  }) as typeof fetch;
  return { fn, sent };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A server-sent-events response: each item is one `data:` event (objects as JSON), split into byte pieces as given. */
export function sse(events: Array<unknown>, opts: { done?: boolean; split?: number } = {}) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("") + (opts.done === false ? "" : "data: [DONE]\n\n");
  return () => {
    const bytes = new TextEncoder().encode(text);
    const size = opts.split ?? bytes.length;
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

export const delta = (d: Record<string, unknown>, finish: string | null = null, extra: object = {}) => ({ model: "qwen3:14b", choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra });

async function drain(it: AsyncGenerator<StreamChunk, ModelEnd>) {
  const chunks: StreamChunk[] = [];
  for (;;) {
    const r = await it.next();
    if (r.done) return { chunks, end: r.value };
    chunks.push(r.value);
  }
}

const adapter = (f: { fn: typeof fetch }, apiKey?: string) => new OpenAICompatibleAdapter({ baseUrl: "http://gpu-box:11434/v1/", apiKey, fetch: f.fn });
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({ model: "qwen3:14b", messages: [{ role: "user", text: "hi" }], ...o });
const ok = (content: string, extra: object = {}) => json({ model: "qwen3:14b", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5 }, ...extra });

// --- 5.1 Schemas and the SSE parser --------------------------------------------------------------------

test("SDK schema converted: lower-case types, nullable as a union with null", () => {
  assert.deepEqual(toJsonSchema({ type: Type.OBJECT, properties: { when: { type: Type.STRING, nullable: true } }, required: [] }), {
    type: "object",
    properties: { when: { type: ["string", "null"] } },
    required: [],
  });
});

test("nested items and properties, enum, format and description are kept", () => {
  const schema = {
    type: Type.OBJECT,
    description: "A plan.",
    properties: {
      steps: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { at: { type: Type.STRING, format: "date-time" }, n: { type: Type.INTEGER } }, required: ["at"] } },
      mode: { type: Type.STRING, enum: ["warm", "cold"] },
      ok: { type: Type.BOOLEAN },
      level: { type: Type.NUMBER },
    },
    required: ["steps"],
  };
  assert.deepEqual(toJsonSchema(schema), {
    type: "object",
    description: "A plan.",
    properties: {
      steps: { type: "array", items: { type: "object", properties: { at: { type: "string", format: "date-time" }, n: { type: "integer" } }, required: ["at"] } },
      mode: { type: "string", enum: ["warm", "cold"] },
      ok: { type: "boolean" },
      level: { type: "number" },
    },
    required: ["steps"],
  });
});

async function collect(text: string, split: number) {
  const bytes = new TextEncoder().encode(text);
  async function* body() {
    for (let i = 0; i < bytes.length; i += split) yield bytes.slice(i, i + split);
  }
  const out: string[] = [];
  const it = sseData(body());
  for (;;) {
    const r = await it.next();
    if (r.done) return { out, done: r.value };
    out.push(r.value);
  }
}

test("the SSE parser joins split lines, skips comments and fields, and stops at [DONE]", async () => {
  const text = ': keep-alive\n\nevent: message\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\r\n\r\nid: 7\ndata: [DONE]\n\ndata: {"after":true}\n\n';
  for (const split of [1, 3, 1000]) assert.deepEqual(await collect(text, split), { out: ['{"a":1}', '{"b":\n2}'], done: true });
});

test("the SSE parser keeps a last event without a trailing newline, and reports a missing [DONE]", async () => {
  assert.deepEqual(await collect('data: {"a":1}\n\ndata: {"b":2}', 4), { out: ['{"a":1}', '{"b":2}'], done: false });
  assert.deepEqual(await collect("data: [DONE]", 2), { out: [], done: true });
});

// --- 5.2 Requests and generate ------------------------------------------------------------------------

test("local server without a key: posts to <base>/chat/completions without an Authorization header", async () => {
  const f = fakeFetch(ok("hello"));
  const end = await adapter(f).generate(req());
  assert.equal(f.sent[0].url, "http://gpu-box:11434/v1/chat/completions");
  assert.equal(f.sent[0].init.method, "POST");
  assert.equal(f.sent[0].init.redirect, "error");
  const headers = f.sent[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(end, { finish: "stop", model: "qwen3:14b", usage: { inputTokens: 12, outputTokens: 5, thoughtTokens: 0 }, message: { role: "assistant", text: "hello" } });
});

test("a key is sent as a bearer token, resolved on every call", async () => {
  let key: string | undefined = "sk-one";
  const f = fakeFetch(ok("x"));
  const a = new OpenAICompatibleAdapter({ baseUrl: "https://api.example/v1", apiKey: () => key, fetch: f.fn });
  await a.generate(req());
  key = "sk-two";
  await a.generate(req());
  key = undefined;
  await a.generate(req());
  assert.deepEqual(f.sent.map((s) => (s.init.headers as Record<string, string>).authorization), ["Bearer sk-one", "Bearer sk-two", undefined]);
});

test("structured output: response_format json_schema with the schema; the answer's text comes back for validation", async () => {
  const schema = { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] };
  const f = fakeFetch(ok('{"facts":[]}'));
  const end = await adapter(f).generate(req({ system: "Be brief.", schema, temperature: 0.2, maxOutputTokens: 100 }));
  assert.deepEqual(f.sent[0].body, {
    model: "qwen3:14b",
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "output", schema, strict: false } },
    max_tokens: 100,
    temperature: 0.2,
  });
  assert.equal(end.message.text, '{"facts":[]}');
});

test("a replayed tool exchange and tools are sent in chat-completion shape; other adapters' provider data is left out", async () => {
  const f = fakeFetch(ok("Done."));
  await adapter(f).generate(req({
    system: "sys",
    messages: [
      { role: "user", text: "off" },
      { role: "assistant", text: "On it.", toolCalls: [{ id: "h2", name: "set_light", args: { entity: "light.x", on: false } }], providerData: { adapter: "gemini", value: [{ thoughtSignature: "sig" }] } },
      { role: "tool", callId: "h2", name: "set_light", result: { ok: true } },
      { role: "assistant", text: "It is off." },
    ],
    tools: [
      { name: "set_light", description: "Turns a light on or off.", parameters: { type: Type.OBJECT, properties: { entity: { type: Type.STRING } }, required: ["entity"] } },
      { name: "mcp_search", description: "Searches.", parametersJsonSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "get_current_time", description: "The time." },
    ],
  }));
  const body = f.sent[0].body;
  assert.deepEqual(body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "off" },
    { role: "assistant", content: "On it.", tool_calls: [{ id: "h2", type: "function", function: { name: "set_light", arguments: '{"entity":"light.x","on":false}' } }] },
    { role: "tool", tool_call_id: "h2", content: '{"ok":true}' },
    { role: "assistant", content: "It is off." },
  ]);
  assert.ok(!JSON.stringify(body).includes("sig"), "provider data stays with its adapter");
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "set_light", description: "Turns a light on or off.", parameters: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] } } },
    { type: "function", function: { name: "mcp_search", description: "Searches.", parameters: { type: "object", properties: { q: { type: "string" } } } } },
    { type: "function", function: { name: "get_current_time", description: "The time.", parameters: { type: "object", properties: {} } } },
  ]);
});

test("generate: length and other finish reasons, a null content, and content_filter as blocked", async () => {
  const finish = (reason: string, content: string | null = "x") => json({ choices: [{ message: { content }, finish_reason: reason }] });
  const cut = await adapter(fakeFetch(finish("length"))).generate(req());
  assert.deepEqual([cut.finish, cut.providerReason, cut.model, cut.usage.inputTokens], ["length", "length", "qwen3:14b", 0]);
  assert.deepEqual([(await adapter(fakeFetch(finish("weird"))).generate(req())).finish], ["other"]);
  assert.equal((await adapter(fakeFetch(finish("stop", null))).generate(req())).message.text, "");
  await assert.rejects(adapter(fakeFetch(finish("content_filter"))).generate(req()), (e) => e instanceof LlmError && e.kind === "blocked" && e.reason === "content_filter");
});

// --- 5.3 Streaming ------------------------------------------------------------------------------------

test("a stream asks for usage, yields text as it comes, and ends with the usage of the last chunk that has it", async () => {
  const f = fakeFetch(sse([
    delta({ role: "assistant", content: "" }),
    delta({ content: "It is " }),
    delta({ content: "ten." }, "stop"),
    { model: "qwen3:14b", choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } },
  ], { split: 7 }));
  const { chunks, end } = await drain(adapter(f).stream(req({ thoughts: true })));
  assert.deepEqual(f.sent[0].body.stream, true);
  assert.deepEqual(f.sent[0].body.stream_options, { include_usage: true });
  assert.deepEqual(chunks, [{ kind: "text", text: "It is " }, { kind: "text", text: "ten." }]);
  assert.deepEqual(end, { finish: "stop", model: "qwen3:14b", usage: { inputTokens: 30, outputTokens: 4, thoughtTokens: 0 }, message: { role: "assistant", text: "It is ten." } });
});

test("arguments arrive in pieces: the call is yielded once, with all of its arguments", async () => {
  const pieces = ['{"ent', 'ity": "lig', 'ht.x", ', '"on": ', "false}"];
  const f = fakeFetch(sse([
    delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "set_light", arguments: "" } }] }),
    ...pieces.map((p) => delta({ tool_calls: [{ index: 0, function: { arguments: p } }] })),
    delta({}, "tool_calls"),
  ]));
  const { chunks, end } = await drain(adapter(f).stream(req()));
  assert.deepEqual(chunks, [{ kind: "call", call: { id: "call_1", name: "set_light", args: { entity: "light.x", on: false } } }]);
  assert.equal(end.finish, "stop");
  assert.deepEqual(end.message, { role: "assistant", toolCalls: [{ id: "call_1", name: "set_light", args: { entity: "light.x", on: false } }] });
});

test("a whole call in one delta, and two parallel calls in index order", async () => {
  const whole = await drain(adapter(fakeFetch(sse([delta({ tool_calls: [{ index: 0, id: "c-a", function: { name: "get_current_time", arguments: "" } }] }, "tool_calls")]))).stream(req()));
  assert.deepEqual(whole.chunks, [{ kind: "call", call: { id: "c-a", name: "get_current_time", args: {} } }]);

  const two = await drain(adapter(fakeFetch(sse([
    delta({ tool_calls: [{ index: 1, id: "c-b", function: { name: "jellyfin_search", arguments: '{"q":"Dune"}' } }] }),
    delta({ tool_calls: [{ index: 0, id: "c-a", function: { name: "ha_turn_off", arguments: '{"entity":"light.x"}' } }] }),
    delta({}, "tool_calls"),
  ]))).stream(req()));
  assert.deepEqual(two.chunks.map((c) => c.kind === "call" && [c.call.id, c.call.name]), [["c-a", "ha_turn_off"], ["c-b", "jellyfin_search"]]);
});

test("unreadable tool arguments: no calls, and the call ends with malformed_call", async () => {
  const f = fakeFetch(sse([
    delta({ tool_calls: [{ index: 0, id: "ok", function: { name: "a", arguments: "{}" } }] }),
    delta({ tool_calls: [{ index: 1, id: "bad", function: { name: "b", arguments: '{"when": ' } }] }),
    delta({}, "tool_calls"),
  ]));
  const { chunks, end } = await drain(adapter(f).stream(req()));
  assert.deepEqual(chunks, []);
  assert.equal(end.finish, "malformed_call");
  assert.equal(end.message.toolCalls, undefined);
});

test("no usage reported: the call ends with 0 input and 0 output tokens", async () => {
  const { end } = await drain(adapter(fakeFetch(sse([delta({ content: "hi" }, "stop")]))).stream(req()));
  assert.deepEqual(end.usage, { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 });
});

test("reasoning output ignored: only the answer text is yielded and kept", async () => {
  const f = fakeFetch(sse([delta({ reasoning_content: "Let me think" }), delta({ reasoning: "more" }), delta({ content: "42" }, "stop")]));
  const { chunks, end } = await drain(adapter(f).stream(req({ thoughts: true })));
  assert.deepEqual(chunks, [{ kind: "text", text: "42" }]);
  assert.equal(end.message.text, "42");
});

test("a stream's finish reasons: length, [DONE] without a reason is stop, other, content_filter is blocked", async () => {
  assert.equal((await drain(adapter(fakeFetch(sse([delta({ content: "Half" }, "length")]))).stream(req()))).end.finish, "length");
  assert.equal((await drain(adapter(fakeFetch(sse([delta({ content: "x" })]))).stream(req()))).end.finish, "stop");
  const other = (await drain(adapter(fakeFetch(sse([delta({ content: "x" }, "eos_weird")]))).stream(req()))).end;
  assert.deepEqual([other.finish, other.providerReason], ["other", "eos_weird"]);
  await assert.rejects(drain(adapter(fakeFetch(sse([delta({ content: "x" }, "content_filter")]))).stream(req())), (e) => e instanceof LlmError && e.kind === "blocked" && e.reason === "content_filter");
});

test("a stream cut off before it finished, an error event and an unreadable event are failures", async () => {
  await assert.rejects(drain(adapter(fakeFetch(sse([delta({ content: "Dune is" })], { done: false }))).stream(req())), (e: any) => e.kind === "transient" && e.reason === "network");
  await assert.rejects(drain(adapter(fakeFetch(sse([{ error: { message: "model not loaded" } }]))).stream(req())), (e: any) => e.kind === "failed" && /model not loaded/.test(e.message));
  await assert.rejects(drain(adapter(fakeFetch(sse(["{not json"]))).stream(req())), (e: any) => e.kind === "failed" && /unreadable/.test(e.message));
});

test("calls without an index in one delta keep their place instead of merging", async () => {
  const f = fakeFetch(sse([
    delta({ tool_calls: [{ id: "c-a", function: { name: "ha_turn_off", arguments: '{"entity":"light.x"}' } }, { id: "c-b", function: { name: "jellyfin_search", arguments: '{"q":"Dune"}' } }] }, "tool_calls"),
  ]));
  const { chunks, end } = await drain(adapter(f).stream(req()));
  assert.equal(end.finish, "stop");
  assert.deepEqual(chunks, [
    { kind: "call", call: { id: "c-a", name: "ha_turn_off", args: { entity: "light.x" } } },
    { kind: "call", call: { id: "c-b", name: "jellyfin_search", args: { q: "Dune" } } },
  ]);
});

test("arguments cut off at the output limit are length, not a malformed call", async () => {
  const f = fakeFetch(sse([delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: '{"query":"wea' } }] }, "length")]));
  const { chunks, end } = await drain(adapter(f).stream(req()));
  assert.deepEqual([chunks, end.finish, end.message.toolCalls], [[], "length", undefined]);
  const g = await adapter(fakeFetch(json({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: '{"q' } }] }, finish_reason: "length" }] }))).generate(req());
  assert.deepEqual([g.finish, g.message.toolCalls], ["length", undefined]);
});

test("ids made up for calls without one never repeat across calls, in generate and stream", async () => {
  const a = adapter(fakeFetch(
    json({ choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "a", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
    sse([delta({ tool_calls: [{ index: 0, function: { name: "b", arguments: "{}" } }] }, "tool_calls")]),
  ));
  const first = (await a.generate(req())).message.toolCalls!;
  const second = (await drain(a.stream(req()))).end.message.toolCalls!;
  assert.ok(first[0].id && second[0].id);
  assert.notEqual(first[0].id, second[0].id);
});

test("an error object or no completion in an HTTP 200 answer is a provider failure, not an empty answer", async () => {
  await assert.rejects(adapter(fakeFetch(json({ error: { message: "context length exceeded" } }))).generate(req()), (e: any) => e.kind === "failed" && e.reason === "response" && /context length exceeded/.test(e.message));
  await assert.rejects(adapter(fakeFetch(json({ choices: [] }))).generate(req()), (e: any) => e.kind === "failed" && /no completion/.test(e.message));
  await assert.rejects(adapter(fakeFetch(new Response("<html>", { status: 200 }))).generate(req()), (e: any) => e.kind === "failed" && /not JSON/.test(e.message));
});

test("a stream stopped early is closed, so the server stops generating", async () => {
  let cancelled = 0;
  const reply = () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: "word " }))}\n\n`));
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const it = adapter(fakeFetch(reply)).stream(req());
  assert.equal(((await it.next()).value as StreamChunk & { text: string }).text, "word ");
  await it.return(undefined as never);
  assert.equal(cancelled, 1, "the caller returning closes the body");

  let broken = 0;
  const bad = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {nope\n\n"));
        },
        cancel() {
          broken++;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  await assert.rejects(drain(adapter(fakeFetch(bad)).stream(req())), (e: any) => e.kind === "failed");
  assert.equal(broken, 1, "an unreadable event closes the body");
});

test("reasons that are no HTTP status are named as they are", async () => {
  const { llm } = service(adapter(fakeFetch(sse([{ error: { message: "model not loaded" } }]))));
  const stream = await service(adapter(fakeFetch(sse([{ error: { message: "model not loaded" } }])))).s.streamCall("chat", req(), () => {}).catch((e) => e);
  assert.match(stream.message, /^model call failed \(stream\): model not loaded$/);
  await assert.rejects(llm.generate({ prompt: "p" }), kind("unavailable", /^model call failed \(response\)/));
});

// --- 5.4 Failures, through LlmService -----------------------------------------------------------------

function service(a: OpenAICompatibleAdapter) {
  const lines: string[] = [];
  const waits: number[] = [];
  const s = new LlmService({
    model: a,
    models: { standard: "qwen3:14b", fast: "llama3.2:3b" },
    concurrency: 1,
    timeoutMs: 1000,
    retryDelaysMs: [5, 20],
    sleep: async (ms) => void waits.push(ms),
    log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) },
  });
  return { llm: s.forOwner("brain"), lines, waits, s };
}

const kind = (k: LlmErrorKind, re?: RegExp) => (e: unknown) => e instanceof LlmError && e.kind === k && (!re || re.test(e.message));

test("OpenAI-compatible rate limit with a stated wait: core waits about that long, then succeeds", async () => {
  const f = fakeFetch(json({ error: { message: "slow down" } }, 429, { "retry-after": "37" }), ok("fine"));
  const { llm, lines, waits } = service(adapter(f));
  assert.equal((await llm.generate({ prompt: "p" })).text, "fine");
  assert.equal(f.sent.length, 2);
  assert.ok(waits[0] >= 37000 && waits[0] <= 40700, String(waits[0]));
  assert.match(lines[0], /ok .*\(2 attempts: 429 wait (3[7-9]|40)s\)$/);
});

test("Retry-After as an HTTP date, and retry-after-ms first", () => {
  const now = Date.parse("2026-11-16T10:00:00Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Mon, 16 Nov 2026 10:00:30 GMT" }), now), 30000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Mon, 16 Nov 2026 09:00:00 GMT" }), now), 0);
  assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "1500", "retry-after": "9" }), now), 1500);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" }), now), undefined);
  assert.equal(retryAfterMs(new Headers(), now), undefined);
});

test("wrong key: one attempt, unavailable, and the key is in neither the message nor the log line", async () => {
  const key = "sk-very-secret-key";
  const f = fakeFetch(json({ error: { message: `Incorrect API key provided: ${key}` } }, 401));
  const { llm, lines } = service(adapter(f, key));
  await assert.rejects(llm.generate({ prompt: "p" }), (e) => kind("unavailable", /HTTP 401/)(e) && !(e as Error).message.includes(key) && /\[redacted\]/.test((e as Error).message));
  assert.equal(f.sent.length, 1);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(key), lines[0]);
  assert.match(lines[0], /\(1 attempt: 401\)$/);
});

test("server down: refused connections are unavailable after 3 attempts in total", async () => {
  const f = fakeFetch(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.5:11434") }));
  const { llm, lines } = service(adapter(f));
  await assert.rejects(llm.generate({ prompt: "p" }), kind("unavailable", /model unreachable/));
  assert.equal(f.sent.length, 3);
  assert.match(lines[0], /\(3 attempts: network wait \d+\.\ds, network wait \d+\.\ds, network\)$/);
});

test("400, 404 and 422 are invalid_request without retry; 503 is retried; a plain-text error body is kept short", async () => {
  for (const status of [400, 404, 422]) {
    const f = fakeFetch(json({ error: { message: "response_format is not supported" } }, status));
    await assert.rejects(service(adapter(f)).llm.generate({ prompt: "p" }), kind("invalid_request", new RegExp(`HTTP ${status}\\): response_format is not supported`)));
    assert.equal(f.sent.length, 1);
  }
  const busy = fakeFetch(new Response("x".repeat(500), { status: 503 }), ok("back"));
  assert.equal((await service(adapter(busy)).llm.generate({ prompt: "p" })).text, "back");
  const down = fakeFetch(new Response("x".repeat(500), { status: 503 }));
  await assert.rejects(service(adapter(down)).llm.generate({ prompt: "p" }), (e) => kind("unavailable", /HTTP 503/)(e));
  const err = await adapter(fakeFetch(new Response("y".repeat(500), { status: 500 }))).generate(req()).catch((e) => e);
  assert.equal(err.message.length, 200);
});
