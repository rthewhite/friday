/** The Gemini adapter: neutral requests to Gemini parameters, Gemini responses and failures back (llm-adapters). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, BlockedReason, FinishReason, type GenerateContentParameters, type GenerateContentResponse, type Part } from "@google/genai";
import { LlmError } from "@friday/sdk";
import { GeminiAdapter, geminiFailure, rateLimitInfo, toGeminiContents } from "../src/llm/gemini.js";
import { BlockedError, ProviderError, type ChatMessage, type ChatRequest, type ModelEnd, type StreamChunk } from "../src/llm/types.js";

function stub(response: Partial<GenerateContentResponse>) {
  const calls: GenerateContentParameters[] = [];
  const fn = async (p: GenerateContentParameters) => {
    calls.push(p);
    return response as GenerateContentResponse;
  };
  return { calls, fn };
}

/** An adapter whose streamed calls play `responses` (or throw `error` instead). */
function streaming(responses: Partial<GenerateContentResponse>[], error?: Error) {
  const calls: GenerateContentParameters[] = [];
  const adapter = new GeminiAdapter("k", undefined, undefined, () => async (p) => {
    calls.push(p);
    if (error) throw error;
    return (async function* () {
      yield* responses as GenerateContentResponse[];
    })();
  });
  return { adapter, calls };
}

async function drain(it: AsyncGenerator<StreamChunk, ModelEnd>): Promise<{ chunks: StreamChunk[]; end: ModelEnd }> {
  const chunks: StreamChunk[] = [];
  for (;;) {
    const r = await it.next();
    if (r.done) return { chunks, end: r.value };
    chunks.push(r.value);
  }
}

const parts = (...p: Part[]): Partial<GenerateContentResponse> => ({ candidates: [{ content: { role: "model", parts: p } }] });
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", messages: [{ role: "user", text: "go" }], ...o });

// --- Mapping (task 3.1) -------------------------------------------------------------------------------

test("ids go to Gemini only when Gemini supplied them", () => {
  const messages: ChatMessage[] = [
    { role: "user", text: "go" },
    { role: "assistant", toolCalls: [{ id: "x1", name: "a", args: {} }], providerData: { adapter: "gemini", value: [{ functionCall: { id: "x1", name: "a", args: {} } }] } },
    { role: "tool", callId: "x1", name: "a", result: { ok: 1 } },
    { role: "assistant", toolCalls: [{ id: "h4", name: "b", args: { q: 1 } }] },
    { role: "tool", callId: "h4", name: "b", result: { ok: 2 } },
  ];
  assert.deepEqual(toGeminiContents(messages), [
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [{ functionCall: { id: "x1", name: "a", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { id: "x1", name: "a", response: { ok: 1 } } }] },
    { role: "model", parts: [{ functionCall: { name: "b", args: { q: 1 } } }] },
    { role: "user", parts: [{ functionResponse: { name: "b", response: { ok: 2 } } }] },
  ]);
});

test("another adapter's provider data is left out: its text and calls are sent", () => {
  const contents = toGeminiContents([
    { role: "user", text: "go" },
    { role: "assistant", text: "Looking.", toolCalls: [{ id: "call_9", name: "a", args: { x: 1 } }], providerData: { adapter: "openai", value: { anything: true } } },
    { role: "tool", callId: "call_9", name: "a", result: { ok: true } },
  ]);
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [{ text: "Looking." }, { functionCall: { name: "a", args: { x: 1 } } }] },
    { role: "user", parts: [{ functionResponse: { name: "a", response: { ok: true } } }] },
  ]);
});

test("merging turns never changes a stored turn's parts", () => {
  const first: Part[] = [{ text: "Looking.", thoughtSignature: "s" }];
  const second: Part[] = [{ functionCall: { name: "a", args: {} } }];
  const contents = toGeminiContents([
    { role: "assistant", providerData: { adapter: "gemini", value: first } },
    { role: "assistant", providerData: { adapter: "gemini", value: second } },
  ]);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].parts!.length, 2);
  assert.deepEqual([first.length, second.length], [1, 1]);
});

test("made-up call ids never repeat across rounds, so a multi-round request keeps them unique", async () => {
  let round = 0;
  const adapter = new GeminiAdapter("k", undefined, undefined, () => async () => {
    round++;
    return (async function* () {
      yield parts({ functionCall: { name: `tool${round}`, args: {} } }) as GenerateContentResponse;
    })();
  });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(...(await drain(adapter.stream(req()))).end.message.toolCalls!.map((c) => c.id));
  assert.equal(new Set(ids).size, 3);
});

// --- Calls (task 3.2) ---------------------------------------------------------------------------------

const ok: Partial<GenerateContentResponse> = {
  candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }, { text: '{"facts":' }, { text: "[]}" }] }, finishReason: FinishReason.STOP }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 30 },
  modelVersion: "gemini-3.8-flash",
};

test("generate maps the request and returns the answer without thoughts, the model version and usage", async () => {
  const s = stub(ok);
  const signal = new AbortController().signal;
  const schema = { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] };
  const end = await new GeminiAdapter("k", s.fn).generate(req({ system: "Be brief.", messages: [{ role: "user", text: "hi" }], schema, temperature: 0.2, maxOutputTokens: 100 }), { signal });
  assert.deepEqual(s.calls, [{
    model: "m",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config: { systemInstruction: "Be brief.", temperature: 0.2, maxOutputTokens: 100, responseMimeType: "application/json", responseJsonSchema: schema, abortSignal: signal },
  }]);
  assert.deepEqual(end, { finish: "stop", model: "gemini-3.8-flash", usage: { inputTokens: 12, outputTokens: 5, thoughtTokens: 30 }, message: { role: "assistant", text: '{"facts":[]}' } });
});

test("generate: MAX_TOKENS is length, MALFORMED_FUNCTION_CALL malformed_call, anything else other", async () => {
  const finish = async (reason: FinishReason) => {
    const end = await new GeminiAdapter("k", stub({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: reason }] }).fn).generate(req());
    return [end.finish, end.providerReason];
  };
  assert.deepEqual(await finish(FinishReason.MAX_TOKENS), ["length", "MAX_TOKENS"]);
  assert.deepEqual(await finish(FinishReason.MALFORMED_FUNCTION_CALL), ["malformed_call", "MALFORMED_FUNCTION_CALL"]);
  assert.deepEqual(await finish(FinishReason.FINISH_REASON_UNSPECIFIED), ["other", "FINISH_REASON_UNSPECIFIED"]);
  assert.deepEqual(await finish(FinishReason.STOP), ["stop", undefined]);
});

test("generate: a blocked prompt or a safety stop is blocked with the reason, the model and the usage", async () => {
  const prompt = new GeminiAdapter("k", stub({ promptFeedback: { blockReason: BlockedReason.PROHIBITED_CONTENT }, usageMetadata: { promptTokenCount: 3 } }).fn);
  await assert.rejects(prompt.generate(req()), (e) =>
    e instanceof BlockedError && e instanceof LlmError && e.kind === "blocked" && e.reason === "PROHIBITED_CONTENT" && /blocked the prompt \(PROHIBITED_CONTENT\)/.test(e.message) && e.usage.inputTokens === 3 && e.model === "m");
  const stop = new GeminiAdapter("k", stub({ candidates: [{ content: { parts: [] }, finishReason: FinishReason.RECITATION }] }).fn);
  await assert.rejects(stop.generate(req()), (e) => e instanceof BlockedError && e.reason === "RECITATION" && /blocked the response/.test(e.message));
});

test("without a key the adapter is unavailable and nothing is called", async () => {
  const s = stub(ok);
  await assert.rejects(new GeminiAdapter("", s.fn).generate(req()), (e) => e instanceof LlmError && e.kind === "unavailable" && /GEMINI_API_KEY is not configured/.test(e.message));
  const st = streaming([parts({ text: "x" })]);
  await assert.rejects(drain(new GeminiAdapter("", undefined, undefined, () => async () => (async function* () {})()).stream(req())), (e) => e instanceof LlmError && e.kind === "unavailable");
  assert.equal(s.calls.length + st.calls.length, 0);
});

test("the key is resolved per call; one client per key value, rebuilt when the key changes", async () => {
  let key: string | undefined = "key-one";
  const built: string[] = [];
  const m = new GeminiAdapter(() => key, undefined, (k) => {
    built.push(k);
    return async () => ({ candidates: [{ content: { role: "model", parts: [{ text: `via ${k}` }] }, finishReason: FinishReason.STOP }] }) as GenerateContentResponse;
  });
  assert.equal((await m.generate(req())).message.text, "via key-one");
  assert.equal((await m.generate(req())).message.text, "via key-one");
  key = "key-two";
  assert.equal((await m.generate(req())).message.text, "via key-two");
  assert.deepEqual(built, ["key-one", "key-two"]);
});

test("a stream yields text, calls with ids, and thoughts only when asked; its message keeps the turn's parts", async () => {
  const responses = [
    parts({ text: "hmm", thought: true }, { thoughtSignature: "sig-0" }),
    parts({ text: "Look" }, { text: "ing.", thoughtSignature: "sig-t" }),
    { ...parts({ functionCall: { name: "a", args: { x: 1 } }, thoughtSignature: "sig-1" }, { functionCall: { id: "g7", name: "b" } }), usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
    { candidates: [{ finishReason: FinishReason.STOP }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2 }, modelVersion: "gemini-x-001" },
  ];
  const withThoughts = await drain(streaming(responses).adapter.stream(req({ thoughts: true })));
  assert.deepEqual(withThoughts.chunks, [
    { kind: "thought", text: "hmm" },
    { kind: "text", text: "Look" },
    { kind: "text", text: "ing." },
    { kind: "call", call: { id: "c1", name: "a", args: { x: 1 } } },
    { kind: "call", call: { id: "g7", name: "b", args: {} } },
  ]);
  const { end } = withThoughts;
  assert.deepEqual({ finish: end.finish, model: end.model, usage: end.usage }, { finish: "stop", model: "gemini-x-001", usage: { inputTokens: 9, outputTokens: 4, thoughtTokens: 2 } });
  assert.deepEqual(end.message, {
    role: "assistant",
    text: "Looking.",
    toolCalls: [{ id: "c1", name: "a", args: { x: 1 } }, { id: "g7", name: "b", args: {} }],
    providerData: {
      adapter: "gemini",
      value: [{ thoughtSignature: "sig-0" }, { text: "Look" }, { text: "ing.", thoughtSignature: "sig-t" }, { functionCall: { name: "a", args: { x: 1 } }, thoughtSignature: "sig-1" }, { functionCall: { id: "g7", name: "b" } }],
    },
  });
  const without = await drain(streaming(responses).adapter.stream(req()));
  assert.ok(!without.chunks.some((c) => c.kind === "thought"));
});

test("thought signature within a turn: the call goes back with its signature, unchanged", async () => {
  const s = streaming([parts({ functionCall: { name: "a", args: {} }, thoughtSignature: "sig-1" })]);
  const first = req({ tools: [{ name: "a", description: "A." }] });
  const { end } = await drain(s.adapter.stream(first));
  const next = streaming([parts({ text: "Done." })]);
  await drain(next.adapter.stream({ ...first, messages: [...first.messages, end.message, { role: "tool", callId: end.message.toolCalls![0].id, name: "a", result: { ok: true } }] }));
  assert.deepEqual(next.calls[0].contents, [
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [{ functionCall: { name: "a", args: {} }, thoughtSignature: "sig-1" }] },
    { role: "user", parts: [{ functionResponse: { name: "a", response: { ok: true } } }] },
  ]);
});

test("a stream's finish reasons: MAX_TOKENS is length, MALFORMED_FUNCTION_CALL malformed_call, none is stop", async () => {
  const end = async (r?: FinishReason) => (await drain(streaming([parts({ text: "x" }), { candidates: [{ ...(r ? { finishReason: r } : {}) }] }]).adapter.stream(req()))).end;
  assert.equal((await end(FinishReason.MAX_TOKENS)).finish, "length");
  assert.equal((await end(FinishReason.MALFORMED_FUNCTION_CALL)).finish, "malformed_call");
  assert.equal((await end()).finish, "stop");
  assert.deepEqual([(await end(FinishReason.LANGUAGE)).finish, (await end(FinishReason.LANGUAGE)).providerReason], ["other", "LANGUAGE"]);
});

test("safety stop: a stream ending with SAFETY rejects with blocked and the reason SAFETY", async () => {
  const s = streaming([parts({ text: "Well" }), { candidates: [{ finishReason: FinishReason.SAFETY }] }]);
  await assert.rejects(drain(s.adapter.stream(req())), (e) => e instanceof LlmError && e.kind === "blocked" && e.reason === "SAFETY");
  const prompt = streaming([{ promptFeedback: { blockReason: BlockedReason.BLOCKLIST } }]);
  await assert.rejects(drain(prompt.adapter.stream(req())), (e) => e instanceof LlmError && e.kind === "blocked" && e.reason === "BLOCKLIST");
});

// --- Failures (task 3.3) ------------------------------------------------------------------------------

function rateLimited(opts: { retryDelay?: string; quotaId?: string } = {}) {
  const details: unknown[] = [];
  if (opts.quotaId) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: opts.quotaId, quotaDimensions: { location: "global", model: "gemini-3.8-flash" }, quotaValue: "10" }],
    });
  }
  details.push({ "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more about Gemini API quotas", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }] });
  if (opts.retryDelay) details.push({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: opts.retryDelay });
  const body = { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED", details } };
  return new ApiError({ message: JSON.stringify(body), status: 429 });
}

test("rateLimitInfo reads Gemini's retry delay and quota, and tolerates anything else", () => {
  const perMinute = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
  assert.deepEqual(rateLimitInfo(rateLimited({ retryDelay: "37s", quotaId: perMinute }).message), { waitMs: 37000, quota: perMinute });
  assert.deepEqual(rateLimitInfo(rateLimited({ retryDelay: "1.5s" }).message), { waitMs: 1500 });
  assert.deepEqual(rateLimitInfo(rateLimited({ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }).message), { quota: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" });
  assert.deepEqual(rateLimitInfo(JSON.stringify({ error: { code: 429, message: "slow down" } })), {});
  assert.deepEqual(rateLimitInfo("got status: 429 Too Many Requests"), {});
  assert.deepEqual(rateLimitInfo(JSON.stringify({ error: { details: [{ "@type": "x.RetryInfo", retryDelay: "soon" }] } })), {});
});

test("Gemini failures map to neutral ones", () => {
  const f = (e: unknown) => geminiFailure(e) as ProviderError;
  const limited = f(rateLimited({ retryDelay: "37s", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }));
  assert.ok(limited instanceof ProviderError);
  assert.deepEqual([limited.kind, limited.reason, limited.waitMs, limited.quota, limited.daily], ["rate_limited", "429", 37000, "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", false]);
  const daily = f(rateLimited({ retryDelay: "2s", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }));
  assert.equal(daily.daily, true);
  const bare = f(rateLimited());
  assert.deepEqual([bare.kind, bare.waitMs, bare.quota, bare.daily], ["rate_limited", undefined, undefined, undefined]);
  for (const s of [408, 500, 502, 503, 504]) assert.deepEqual([f(new ApiError({ message: "x", status: s })).kind, f(new ApiError({ message: "x", status: s })).reason], ["transient", String(s)]);
  for (const s of [400, 404, 422]) assert.equal(f(new ApiError({ message: "bad", status: s })).kind, "invalid_request");
  for (const s of [401, 403, 501]) assert.equal(f(new ApiError({ message: "no", status: s })).kind, "failed");
  const network = f(new TypeError("fetch failed"));
  assert.deepEqual([network.kind, network.reason, network.message], ["transient", "network", "fetch failed"]);
  const own = new LlmError("unavailable", "x");
  assert.equal(geminiFailure(own), own);
});

test("failures of a call or a stream reach the caller as neutral errors", async () => {
  const failing = (e: Error) => new GeminiAdapter("k", async () => { throw e; });
  await assert.rejects(failing(new ApiError({ message: "busy", status: 503 })).generate(req()), (e) => e instanceof ProviderError && e.kind === "transient" && e.reason === "503");
  await assert.rejects(drain(streaming([], new ApiError({ message: "bad", status: 400 })).adapter.stream(req())), (e) => e instanceof ProviderError && e.kind === "invalid_request");
  const midway = new GeminiAdapter("k", undefined, undefined, () => async () => (async function* () {
    yield parts({ text: "Hel" }) as GenerateContentResponse;
    throw new TypeError("socket hang up");
  })());
  await assert.rejects(drain(midway.stream(req())), (e) => e instanceof ProviderError && e.reason === "network");
});
