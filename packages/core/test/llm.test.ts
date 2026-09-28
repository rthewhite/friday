import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@google/genai";
import { LlmError, type LlmErrorKind } from "@friday/sdk";
import { GeminiTextModel, type TextModel, type TextRequest, type TextResponse } from "../src/llm/gemini.js";
import { classify, LlmService, rateLimitInfo, type LlmServiceOptions } from "../src/llm/service.js";
import { sleep, waitFor } from "./helpers.js";

type Step = TextResponse | Error | ((req: TextRequest, signal?: AbortSignal) => Promise<TextResponse>);

const answer = (text: string, extra: Partial<TextResponse> = {}): TextResponse => ({
  text,
  finishReason: "STOP",
  model: "gemini-test-001",
  usage: { inputTokens: 10, outputTokens: 4, thoughtTokens: 0 },
  ...extra,
});

/** A TextModel that plays `steps` in order (the last one repeats) and records every call. */
function fakeModel(...steps: Step[]) {
  const calls: { req: TextRequest; signal?: AbortSignal }[] = [];
  const model: TextModel = {
    async generate(req, opts = {}) {
      calls.push({ req, signal: opts.signal });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (typeof step === "function") return step(req, opts.signal);
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { model, calls };
}

function service(model: TextModel, o: Partial<LlmServiceOptions> = {}) {
  const lines: string[] = [];
  const s = new LlmService({
    model,
    models: { standard: "std-model", fast: "fast-model" },
    concurrency: 2,
    timeoutMs: 1000,
    retryDelaysMs: [5, 20],
    log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) },
    ...o,
  });
  return { s, lines, llm: s.forOwner("brain") };
}

const kind = (k: LlmErrorKind, re?: RegExp) => (e: unknown) => e instanceof LlmError && e.kind === k && (!re || re.test(e.message));
const http = (status: number) => new ApiError({ message: `status ${status}`, status });

/** A step that hangs until its signal aborts, like a real provider request. */
const hang = (_req: TextRequest, signal?: AbortSignal) =>
  new Promise<TextResponse>((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

test("plain text resolves with text, the configured model name and usage", async () => {
  const f = fakeModel(answer("Hello there"));
  const { llm, lines } = service(f.model);
  assert.deepEqual(await llm.generate({ system: "s", prompt: "Summarise: secret words" }), {
    text: "Hello there",
    model: "std-model",
    usage: { inputTokens: 10, outputTokens: 4, thoughtTokens: 0 },
  });
  assert.equal(f.calls[0].req.model, "std-model");
  assert.equal(f.calls[0].req.system, "s");
  assert.match(lines[0], /^llm: \[brain\] std-model \(gemini-test-001\) ok in=10 out=4 \d+\.\ds \(1 attempt\)$/);
});

test("the fast tier uses the fast model", async () => {
  const f = fakeModel(answer("x"));
  const r = await service(f.model).llm.generate({ prompt: "p", model: "fast" });
  assert.equal(f.calls[0].req.model, "fast-model");
  assert.equal(r.model, "fast-model");
});

test("a schema answer is validated; an empty result resolves", async () => {
  const schema = { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] };
  const { llm } = service(fakeModel(answer('{"facts": []}'), answer('{"fact": "x"}'), answer('{"facts": [', { finishReason: "MAX_TOKENS" })).model);
  assert.deepEqual((await llm.generate({ prompt: "p", schema })).json, { facts: [] });
  await assert.rejects(llm.generate({ prompt: "p", schema }), (e) => kind("invalid_output")(e) && (e as LlmError).raw === '{"fact": "x"}');
  await assert.rejects(llm.generate({ prompt: "p", schema }), kind("invalid_output", /truncated/));
});

test("invalid requests reject without calling the model", async () => {
  const f = fakeModel(answer("x"));
  const { llm } = service(f.model);
  await assert.rejects(llm.generate({ prompt: "p", messages: [{ role: "user", text: "m" }] }), kind("invalid_request"));
  await assert.rejects(llm.generate({ prompt: "p", schema: { type: "bogus" } }), kind("invalid_request"));
  assert.equal(f.calls.length, 0);
});

test("503 once, then ok, resolves", async () => {
  const f = fakeModel(http(503), answer("ok"));
  const { llm, lines } = service(f.model);
  assert.equal((await llm.generate({ prompt: "p" })).text, "ok");
  assert.equal(f.calls.length, 2);
  assert.match(lines[0], /ok .*\(2 attempts: 503 wait \d+\.\ds\)$/);
});

test("persistent 503 is unavailable after 3 attempts", async () => {
  const f = fakeModel(http(503));
  const { llm, lines } = service(f.model);
  await assert.rejects(llm.generate({ prompt: "p" }), kind("unavailable", /HTTP 503/));
  assert.equal(f.calls.length, 3);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^llm: \[brain\] std-model unavailable: .*\(3 attempts: 503 wait \d+\.\ds, 503 wait \d+\.\ds, 503\)$/);
});

test("429 and network errors are retried; 400 and 404 are invalid_request without retry", async () => {
  const net = fakeModel(new TypeError("fetch failed"), http(429), answer("ok"));
  assert.equal((await service(net.model).llm.generate({ prompt: "p" })).text, "ok");
  assert.equal(net.calls.length, 3);
  for (const status of [400, 404]) {
    const f = fakeModel(http(status));
    await assert.rejects(service(f.model).llm.generate({ prompt: "p" }), kind("invalid_request", new RegExp(`HTTP ${status}`)));
    assert.equal(f.calls.length, 1);
  }
});

test("a blocked prompt or a safety stop is blocked with the reason, without retry", async () => {
  const prompt = fakeModel(answer("", { blockReason: "SAFETY", finishReason: undefined }));
  await assert.rejects(service(prompt.model).llm.generate({ prompt: "p" }), (e) => kind("blocked")(e) && (e as LlmError).reason === "SAFETY");
  assert.equal(prompt.calls.length, 1);
  const stop = fakeModel(answer("partial", { finishReason: "RECITATION" }));
  await assert.rejects(service(stop.model).llm.generate({ prompt: "p" }), (e) => kind("blocked")(e) && (e as LlmError).reason === "RECITATION");
  assert.equal(stop.calls.length, 1);
});

test("a timeout is unavailable, aborts the provider request, and is not retried", async () => {
  const f = fakeModel(hang);
  const { llm } = service(f.model);
  await assert.rejects(llm.generate({ prompt: "p", timeoutMs: 30 }), kind("unavailable", /timed out after 30 ms/));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal?.aborted, true);
});

test("the timeout covers each attempt, not the queue wait", async () => {
  const f = fakeModel(async () => (await sleep(40), answer("slow")));
  const { llm } = service(f.model, { concurrency: 1, timeoutMs: 60 });
  const all = await Promise.all([llm.generate({ prompt: "1" }), llm.generate({ prompt: "2" }), llm.generate({ prompt: "3" })]);
  assert.deepEqual(all.map((r) => r.text), ["slow", "slow", "slow"]);
});

test("aborting in flight cancels and aborts the provider request", async () => {
  const f = fakeModel(hang);
  const { llm, lines } = service(f.model);
  const ac = new AbortController();
  const p = llm.generate({ prompt: "p", signal: ac.signal });
  await waitFor(() => f.calls.length === 1);
  ac.abort();
  await assert.rejects(p, kind("cancelled"));
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.match(lines[0], /^llm: \[brain\] std-model cancelled/);
});

test("aborting while queued cancels and frees the queue position", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fakeModel(async (req) => (await gate, answer(req.prompt!)));
  const { llm } = service(f.model, { concurrency: 1 });
  const first = llm.generate({ prompt: "first" });
  const ac = new AbortController();
  const queued = llm.generate({ prompt: "queued", signal: ac.signal });
  const third = llm.generate({ prompt: "third" });
  await waitFor(() => f.calls.length === 1);
  ac.abort();
  await assert.rejects(queued, kind("cancelled"));
  release();
  assert.equal((await first).text, "first");
  assert.equal((await third).text, "third");
  assert.deepEqual(f.calls.map((c) => c.req.prompt), ["first", "third"]);
});

test("aborting during a retry delay cancels", async () => {
  const f = fakeModel(http(503));
  const { llm } = service(f.model, { retryDelaysMs: [1000, 1000] });
  const ac = new AbortController();
  const p = llm.generate({ prompt: "p", signal: ac.signal });
  await waitFor(() => f.calls.length === 1);
  const t0 = Date.now();
  ac.abort();
  await assert.rejects(p, kind("cancelled"));
  assert.ok(Date.now() - t0 < 500);
});

test("an already aborted signal cancels without calling the model", async () => {
  const f = fakeModel(answer("x"));
  await assert.rejects(service(f.model).llm.generate({ prompt: "p", signal: AbortSignal.abort() }), kind("cancelled"));
  assert.equal(f.calls.length, 0);
});

test("5 concurrent calls run 2 at a time in arrival order", async () => {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  let running = 0, peak = 0;
  const f = fakeModel(async (req) => {
    started.push(req.prompt!);
    peak = Math.max(peak, ++running);
    await new Promise<void>((r) => finish.set(req.prompt!, r));
    running--;
    return answer(req.prompt!);
  });
  const { llm } = service(f.model);
  const calls = ["a", "b", "c", "d", "e"].map((p) => llm.generate({ prompt: p }));
  await waitFor(() => started.length === 2);
  await sleep(10);
  assert.deepEqual(started, ["a", "b"]);
  finish.get("b")!();
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ["a", "b", "c"]);
  finish.get("a")!();
  await waitFor(() => started.length === 4);
  finish.get("c")!();
  await waitFor(() => started.length === 5);
  for (const p of ["d", "e"]) finish.get(p)!();
  assert.deepEqual((await Promise.all(calls)).map((r) => r.text), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
  assert.equal(peak, 2);
});

test("a missing key is unavailable and not retried", async () => {
  const { llm, lines } = service(new GeminiTextModel(""));
  await assert.rejects(llm.generate({ prompt: "p" }), kind("unavailable", /GEMINI_API_KEY is not configured/));
  assert.match(lines[0], /unavailable: GEMINI_API_KEY is not configured .*\(1 attempt\)$/);
});

test("log lines never contain prompts, messages or output", async () => {
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  const f = fakeModel(answer("TOP-SECRET-ANSWER"), answer('{"leak": "TOP-SECRET-ANSWER"}'), http(503));
  const { llm, lines } = service(f.model, { retryDelaysMs: [1, 1] });
  await llm.generate({ system: "TOP-SECRET-SYSTEM", prompt: "TOP-SECRET-PROMPT" });
  await assert.rejects(llm.generate({ messages: [{ role: "user", text: "TOP-SECRET-MESSAGE" }], schema }), kind("invalid_output"));
  await assert.rejects(llm.generate({ prompt: "TOP-SECRET-PROMPT" }), kind("unavailable"));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.doesNotMatch(l, /TOP-SECRET/);
  assert.match(lines[1], /^llm: \[brain\] std-model \(gemini-test-001\) invalid_output: output does not match the schema.* in=10 out=4 /);
});

/** A 429 as Gemini sends it, JSON-encoded in ApiError.message by @google/genai. */
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

/** A sleep that records requested waits and returns at once, honouring abort like the real one. */
function recordingSleep() {
  const waits: number[] = [];
  const fn = (ms: number, signal?: AbortSignal) => {
    waits.push(ms);
    return signal?.aborted ? Promise.reject(new LlmError("cancelled", "text generation was cancelled")) : Promise.resolve();
  };
  return { waits, fn };
}

test("rateLimitInfo reads Gemini's retry delay and quota, and tolerates anything else", () => {
  const perMinute = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
  assert.deepEqual(rateLimitInfo(rateLimited({ retryDelay: "37s", quotaId: perMinute }).message), { waitMs: 37000, quota: perMinute });
  assert.deepEqual(rateLimitInfo(rateLimited({ retryDelay: "1.5s" }).message), { waitMs: 1500 });
  assert.deepEqual(rateLimitInfo(rateLimited({ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }).message), { quota: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" });
  assert.deepEqual(rateLimitInfo(JSON.stringify({ error: { code: 429, message: "slow down" } })), {});
  assert.deepEqual(rateLimitInfo("got status: 429 Too Many Requests"), {});
  assert.deepEqual(rateLimitInfo(JSON.stringify({ error: { details: [{ "@type": "x.RetryInfo", retryDelay: "soon" }] } })), {});
  const f = classify(rateLimited({ retryDelay: "37s" }));
  assert.equal(f.retry, true);
  assert.equal(f.reason, "429");
  assert.equal(f.waitMs, 37000);
  assert.equal(classify(new TypeError("fetch failed")).reason, "network");
});

test("a 429 with a stated wait retries after at least that wait, keeping the call's slot", async () => {
  const f = fakeModel(rateLimited({ retryDelay: "37s", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }), answer("ok"));
  const sleep = recordingSleep();
  const { llm, lines } = service(f.model, { sleep: sleep.fn, concurrency: 1 });
  assert.equal((await llm.generate({ prompt: "p" })).text, "ok");
  assert.equal(f.calls.length, 2);
  assert.equal(sleep.waits.length, 1);
  assert.ok(sleep.waits[0] >= 37000 && sleep.waits[0] <= 40700, String(sleep.waits[0]));
  assert.match(lines[0], /ok .*\(2 attempts: 429 wait (3[7-9]|40|41)s\)$/);
});

test("a stated wait beyond the bound, or a daily quota, fails at once without another attempt", async () => {
  const over = fakeModel(rateLimited({ retryDelay: "90s" }));
  const a = service(over.model, { sleep: recordingSleep().fn, maxRetryWaitMs: 60000 });
  await assert.rejects(a.llm.generate({ prompt: "p" }), kind("unavailable", /provider asks to wait 90s \(limit 60s\)/));
  assert.equal(over.calls.length, 1);
  assert.match(a.lines[0], /\(1 attempt: 429\)$/);

  const daily = fakeModel(rateLimited({ retryDelay: "2s", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }));
  const b = service(daily.model, { sleep: recordingSleep().fn });
  await assert.rejects(b.llm.generate({ prompt: "p" }), kind("unavailable", /daily quota GenerateRequestsPerDayPerProjectPerModel-FreeTier exhausted/));
  assert.equal(daily.calls.length, 1);
});

test("a request's maxRetryWaitMs overrides the service bound", async () => {
  const strict = fakeModel(rateLimited({ retryDelay: "5s" }), answer("ok"));
  await assert.rejects(service(strict.model, { sleep: recordingSleep().fn }).llm.generate({ prompt: "p", maxRetryWaitMs: 1000 }), kind("unavailable", /wait 5\.0s \(limit 1\.0s\)/));
  assert.equal(strict.calls.length, 1);

  const patient = fakeModel(rateLimited({ retryDelay: "90s" }), answer("ok"));
  const sleep = recordingSleep();
  assert.equal((await service(patient.model, { sleep: sleep.fn, maxRetryWaitMs: 60000 }).llm.generate({ prompt: "p", maxRetryWaitMs: 120000 })).text, "ok");
  assert.ok(sleep.waits[0] >= 90000);
});

test("a 429 without a stated wait falls back to the fixed backoff", async () => {
  const f = fakeModel(rateLimited(), rateLimited(), answer("ok"));
  const sleep = recordingSleep();
  const { llm, lines } = service(f.model, { sleep: sleep.fn, retryDelaysMs: [1000, 4000] });
  assert.equal((await llm.generate({ prompt: "p" })).text, "ok");
  assert.ok(sleep.waits[0] >= 800 && sleep.waits[0] <= 1200 && sleep.waits[1] >= 3200 && sleep.waits[1] <= 4800, String(sleep.waits));
  assert.match(lines[0], /\(3 attempts: 429 wait \d\.\ds, 429 wait \d\.\ds\)$/);
});

test("aborting while waiting out a rate limit cancels at once", async () => {
  const f = fakeModel(rateLimited({ retryDelay: "30s" }));
  const { llm } = service(f.model);
  const ac = new AbortController();
  const p = llm.generate({ prompt: "p", signal: ac.signal });
  await waitFor(() => f.calls.length === 1);
  const t0 = Date.now();
  ac.abort();
  await assert.rejects(p, kind("cancelled"));
  assert.ok(Date.now() - t0 < 500);
  assert.equal(f.calls.length, 1);
});

test("retry reasons name the status or network, and a clean call lists none", async () => {
  const f = fakeModel(new TypeError("fetch failed"), http(503), answer("ok"));
  const { llm, lines } = service(f.model, { sleep: recordingSleep().fn });
  await llm.generate({ prompt: "TOP-SECRET-PROMPT" });
  await llm.generate({ prompt: "p" });
  assert.match(lines[0], /\(3 attempts: network wait \d+\.\ds, 503 wait \d+\.\ds\)$/);
  assert.match(lines[1], /\(1 attempt\)$/);
  for (const l of lines) assert.doesNotMatch(l, /TOP-SECRET/);
});
