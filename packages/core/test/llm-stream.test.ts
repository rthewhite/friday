/** LlmService.streamCall over a provider-neutral ChatModel (the Gemini stream mapping is in llm-gemini-adapter.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, type LlmErrorKind } from "@friday/sdk";
import { LlmService, type LlmServiceOptions } from "../src/llm/service.js";
import { BlockedError, ProviderError, type ChatModel, type ChatRequest, type ModelEnd, type ModelStream, type StreamChunk } from "../src/llm/types.js";
import { waitFor } from "./helpers.js";

const kind = (k: LlmErrorKind, re?: RegExp) => (e: unknown) => e instanceof LlmError && e.kind === k && (!re || re.test(e.message));
const usage = { inputTokens: 7, outputTokens: 3, thoughtTokens: 1 };
const end: ModelEnd = { finish: "stop", model: "gemini-test-001", usage, message: { role: "assistant", text: "SECRET-ANSWER" } };
const text = (t: string): StreamChunk => ({ kind: "text", text: t });

type Play = Array<StreamChunk | Error | "hang"> | Error;

/** A ChatModel whose `stream` plays one script per call (the last repeats); "hang" waits for the signal. */
function fakeStreamModel(...scripts: Play[]) {
  const calls: { req: ChatRequest; signal?: AbortSignal }[] = [];
  const model: ChatModel = {
    generate: async () => ({ finish: "stop", model: "gen-model", usage, message: { role: "assistant", text: "gen" } }),
    stream(req, opts = {}): ModelStream {
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

function service(model: ChatModel, o: Partial<LlmServiceOptions> = {}) {
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

const req = (extra: object = {}) => ({ model: "chat-model", system: "SECRET-SYSTEM", messages: [{ role: "user" as const, text: "SECRET-QUESTION" }], ...extra });

test("streamCall forwards chunks in order and logs one content-free line under the owner", async () => {
  const f = fakeStreamModel([text("SECRET-"), text("ANSWER")]);
  const { s, lines } = service(f.model);
  const got: string[] = [];
  const r = await s.streamCall("chat", req({ tools: [{ name: "t", description: "" }], thoughts: true, timeoutMs: 500, maxRetryWaitMs: 10 }), (c) => got.push(c.kind === "text" ? c.text : c.kind));
  assert.deepEqual(got, ["SECRET-", "ANSWER"]);
  assert.deepEqual(r, end);
  assert.deepEqual(f.calls[0].req, { model: "chat-model", system: "SECRET-SYSTEM", messages: req().messages, tools: [{ name: "t", description: "" }], thoughts: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^llm: \[chat\] chat-model \(gemini-test-001\) ok in=7 out=3 think=1 \d+\.\ds \(1 attempt\)$/);
  assert.doesNotMatch(lines[0], /SECRET/);
});

test("a 429 before any output is retried after the stated wait and logged", async () => {
  const limited = new ProviderError("rate_limited", "429", "slow down", { waitMs: 3000 });
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
  const f = fakeStreamModel([text("Dune is"), new ProviderError("transient", "network", "fetch failed")]);
  const { s, lines } = service(f.model);
  const got: string[] = [];
  await assert.rejects(s.streamCall("chat", req(), (c) => c.kind === "text" && got.push(c.text)), kind("unavailable", /model unreachable/));
  assert.deepEqual(got, ["Dune is"]);
  assert.equal(f.calls.length, 1);
  assert.match(lines[0], /^llm: \[chat\] chat-model unavailable: .* \(1 attempt: network\)$/);
});

test("a blocked stream and a 400 are typed errors without retry", async () => {
  const blocked = fakeStreamModel(new BlockedError("the model provider blocked the response (SAFETY)", "SAFETY", "gemini-test-001", usage));
  const b = service(blocked.model);
  await assert.rejects(b.s.streamCall("chat", req(), () => {}), kind("blocked", /SAFETY/));
  assert.equal(blocked.calls.length, 1);
  assert.match(b.lines[0], /^llm: \[chat\] chat-model \(gemini-test-001\) blocked: .* in=7 out=3 think=1 /);
  const bad = fakeStreamModel(new ProviderError("invalid_request", "400", "bad"));
  await assert.rejects(service(bad.model).s.streamCall("chat", req(), () => {}), kind("invalid_request"));
  assert.equal(bad.calls.length, 1);
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
  const inner = f.model.stream.bind(f.model);
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
    return { finish: "stop", model: "m", usage, message: { role: "assistant", text: "x" } };
  };
  const { s } = service(f.model, { concurrency: 1 });
  const streaming = s.streamCall("chat", req(), () => {});
  await waitFor(() => f.calls.length === 1);
  const queued = s.forOwner("brain").generate({ prompt: "p" });
  // Without the queue the call would reach the model within the pending microtasks; one macrotask covers them.
  await new Promise((r) => setImmediate(r));
  assert.equal(generated, false, "the module call waits while the chat call streams");
  release();
  await streaming;
  await queued;
  assert.equal(generated, true);
});
