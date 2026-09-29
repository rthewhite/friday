import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, FinishReason, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { LlmError, type LlmErrorKind } from "@friday/sdk";
import { GeminiTextModel, type StreamChunk, type StreamEnd, type StreamRequest, type TextModel, type TextStream } from "../src/llm/gemini.js";
import { LlmService, type LlmServiceOptions } from "../src/llm/service.js";
import { waitFor } from "./helpers.js";

const kind = (k: LlmErrorKind, re?: RegExp) => (e: unknown) => e instanceof LlmError && e.kind === k && (!re || re.test(e.message));
const http = (status: number, message = `status ${status}`) => new ApiError({ message, status });
const usage = { inputTokens: 7, outputTokens: 3, thoughtTokens: 1 };
const end: StreamEnd = { finishReason: "STOP", model: "gemini-test-001", usage };
const text = (t: string): StreamChunk => ({ kind: "text", text: t, part: { text: t } });

// ---- GeminiTextModel.stream ----

function streamStub(chunks: Partial<GenerateContentResponse>[]) {
  const calls: GenerateContentParameters[] = [];
  const built: string[] = [];
  const streamFor = (key: string) => {
    built.push(key);
    return async (p: GenerateContentParameters) => {
      calls.push(p);
      return (async function* () {
        for (const c of chunks) yield c as GenerateContentResponse;
      })();
    };
  };
  return { calls, built, streamFor };
}

test("stream maps contents, system, tools and thoughts to generateContentStream", async () => {
  const s = streamStub([{ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: FinishReason.STOP }] }]);
  const m = new GeminiTextModel("k", undefined, undefined, s.streamFor);
  const signal = new AbortController().signal;
  const contents = [{ role: "user", parts: [{ text: "hello" }] }];
  const tools = [{ name: "get_current_time", description: "time" }];
  for await (const _ of m.stream({ model: "m", system: "Be Friday.", contents, tools, thoughts: true }, { signal }));
  assert.deepEqual(s.calls[0], {
    model: "m",
    contents,
    config: { systemInstruction: "Be Friday.", tools: [{ functionDeclarations: tools }], thinkingConfig: { includeThoughts: true }, abortSignal: signal },
  });
  for await (const _ of m.stream({ model: "m", contents, tools: [] }));
  assert.deepEqual(s.calls[1].config, {}, "no tools and no thoughts leave the config empty");
});

test("stream yields thoughts, text, calls (with signatures) and other parts verbatim, then the end", async () => {
  const s = streamStub([
    { candidates: [{ content: { parts: [{ text: "Checking the light", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "ha_get_state", args: { entity: "light.living" } }, thoughtSignature: "sig-1" }] } }] },
    { candidates: [{ content: { parts: [{ text: "It is " }, { text: "on." }] } }], usageMetadata: { promptTokenCount: 5 } },
    { candidates: [{ content: { parts: [{ text: "", thoughtSignature: "sig-2" }] }, finishReason: FinishReason.STOP }], modelVersion: "gemini-3.8-flash", usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 9 } },
  ]);
  const it = new GeminiTextModel("k", undefined, undefined, s.streamFor).stream({ model: "m", contents: [] });
  const chunks: StreamChunk[] = [];
  let r = await it.next();
  while (!r.done) {
    chunks.push(r.value);
    r = await it.next();
  }
  assert.deepEqual(chunks, [
    { kind: "thought", text: "Checking the light", part: { text: "Checking the light", thought: true } },
    { kind: "call", name: "ha_get_state", args: { entity: "light.living" }, part: { functionCall: { name: "ha_get_state", args: { entity: "light.living" } }, thoughtSignature: "sig-1" } },
    { kind: "text", text: "It is ", part: { text: "It is " } },
    { kind: "text", text: "on.", part: { text: "on." } },
    { kind: "other", part: { text: "", thoughtSignature: "sig-2" } },
  ]);
  assert.deepEqual(r.value, { finishReason: "STOP", model: "gemini-3.8-flash", usage: { inputTokens: 12, outputTokens: 4, thoughtTokens: 9 } });
});

test("stream without a key is unavailable; one stream client per key value", async () => {
  let key = "";
  const s = streamStub([]);
  const m = new GeminiTextModel(() => key, undefined, undefined, s.streamFor);
  await assert.rejects(m.stream({ model: "m", contents: [] }).next(), kind("unavailable", /GEMINI_API_KEY is not configured/));
  key = "one";
  await m.stream({ model: "m", contents: [] }).next();
  await m.stream({ model: "m", contents: [] }).next();
  key = "two";
  await m.stream({ model: "m", contents: [] }).next();
  assert.deepEqual(s.built, ["one", "two"]);
});

// ---- LlmService.streamCall ----

type Play = Array<StreamChunk | Error | "hang"> | Error;

/** A TextModel whose `stream` plays one script per call (the last repeats); "hang" waits for the signal. */
function fakeStreamModel(...scripts: Play[]) {
  const calls: { req: StreamRequest; signal?: AbortSignal }[] = [];
  const model: TextModel = {
    generate: async () => ({ text: "gen", model: "gen-model", finishReason: "STOP", usage }),
    stream(req, opts = {}): TextStream {
      calls.push({ req, signal: opts.signal });
      const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
      return (async function* () {
        if (script instanceof Error) throw script;
        for (const step of script) {
          if (step === "hang") {
            await new Promise((_r, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason)));
          } else if (step instanceof Error) throw step;
          else yield step;
        }
        return end;
      })();
    },
  };
  return { model, calls };
}

function service(model: TextModel, o: Partial<LlmServiceOptions> = {}) {
  const lines: string[] = [];
  const waits: number[] = [];
  const s = new LlmService({
    model,
    models: { standard: "std-model", fast: "fast-model" },
    concurrency: 2,
    timeoutMs: 1000,
    retryDelaysMs: [5, 20],
    sleep: async (ms) => void waits.push(ms),
    log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) },
    ...o,
  });
  return { s, lines, waits };
}

const req = (extra: object = {}) => ({ model: "chat-model", system: "SECRET-SYSTEM", contents: [{ role: "user", parts: [{ text: "SECRET-QUESTION" }] }], ...extra });

test("streamCall forwards chunks in order and logs one content-free line under the owner", async () => {
  const f = fakeStreamModel([text("SECRET-"), text("ANSWER")]);
  const { s, lines } = service(f.model);
  const got: string[] = [];
  const r = await s.streamCall("chat", req({ tools: [{ name: "t", description: "" }], thoughts: true }), (c) => got.push(c.kind === "text" ? c.text : c.kind));
  assert.deepEqual(got, ["SECRET-", "ANSWER"]);
  assert.deepEqual(r, end);
  assert.deepEqual(f.calls[0].req, { model: "chat-model", system: "SECRET-SYSTEM", contents: req().contents, tools: [{ name: "t", description: "" }], thoughts: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^llm: \[chat\] chat-model \(gemini-test-001\) ok in=7 out=3 think=1 \d+\.\ds \(1 attempt\)$/);
  assert.doesNotMatch(lines[0], /SECRET/);
});

test("a 429 before any output is retried after the stated wait and logged", async () => {
  const limited = http(429, JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }] } }));
  const f = fakeStreamModel(limited, [text("ok")]);
  const { s, lines, waits } = service(f.model);
  const got: string[] = [];
  await s.streamCall("chat", req(), (c) => c.kind === "text" && got.push(c.text));
  assert.deepEqual(got, ["ok"]);
  assert.equal(f.calls.length, 2);
  assert.ok(waits[0] >= 3000 && waits[0] <= 3300, String(waits[0]));
  assert.match(lines[0], /ok .*\(2 attempts: 429 wait 3\.\ds\)$/);
});

test("a failure after output is not retried and rejects with a typed error", async () => {
  const f = fakeStreamModel([text("Dune is"), new TypeError("fetch failed")]);
  const { s, lines } = service(f.model);
  const got: string[] = [];
  await assert.rejects(s.streamCall("chat", req(), (c) => c.kind === "text" && got.push(c.text)), kind("unavailable", /model unreachable/));
  assert.deepEqual(got, ["Dune is"]);
  assert.equal(f.calls.length, 1);
  assert.match(lines[0], /^llm: \[chat\] chat-model unavailable: .* \(1 attempt: network\)$/);
});

test("a blocked stream, a 400 and a missing stream are typed errors without retry", async () => {
  const blocked = fakeStreamModel([]);
  blocked.model.stream = (async function* () {
    return { ...end, finishReason: "SAFETY" };
  }) as unknown as TextModel["stream"];
  await assert.rejects(service(blocked.model).s.streamCall("chat", req(), () => {}), kind("blocked", /SAFETY/));
  const bad = fakeStreamModel(http(400));
  await assert.rejects(service(bad.model).s.streamCall("chat", req(), () => {}), kind("invalid_request"));
  assert.equal(bad.calls.length, 1);
  const none: TextModel = { generate: async () => ({ text: "", model: "m", usage }) };
  await assert.rejects(service(none).s.streamCall("chat", req(), () => {}), kind("unavailable", /does not support streaming/));
});

test("a stream that stalls times out as unavailable; the caller's abort cancels", async () => {
  const f = fakeStreamModel([text("a"), "hang"]);
  const { s } = service(f.model, { timeoutMs: 30 });
  await assert.rejects(s.streamCall("chat", req(), () => {}), kind("unavailable", /timed out after 30 ms/));
  const g = fakeStreamModel(["hang"]);
  const ac = new AbortController();
  const p = service(g.model).s.streamCall("chat", req({ signal: ac.signal }), () => {});
  await waitFor(() => g.calls.length === 1);
  ac.abort();
  await assert.rejects(p, kind("cancelled"));
  assert.ok(g.calls[0].signal?.aborted, "the provider request is aborted");
});

test("a streaming call holds its slot until it ends and shares the bound with generate", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fakeStreamModel([text("first")]);
  const inner = f.model.stream!.bind(f.model);
  f.model.stream = (r, o) =>
    (async function* () {
      const it = inner(r, o);
      yield (await it.next()).value as StreamChunk;
      await gate;
      return end;
    })();
  let generated = false;
  f.model.generate = async () => {
    generated = true;
    return { text: "x", model: "m", finishReason: "STOP", usage };
  };
  const { s } = service(f.model, { concurrency: 1 });
  const streaming = s.streamCall("chat", req(), () => {});
  await waitFor(() => f.calls.length === 1);
  const queued = s.forOwner("brain").generate({ prompt: "p" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generated, false, "the module call waits while the chat call streams");
  release();
  await streaming;
  await queued;
  assert.equal(generated, true);
});
