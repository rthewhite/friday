import { test } from "node:test";
import assert from "node:assert/strict";
import { FinishReason, BlockedReason, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { LlmError } from "@friday/sdk";
import { llmSettings } from "../src/config.js";
import { GeminiTextModel } from "../src/llm/gemini.js";
import { LlmService } from "../src/llm/service.js";

test("text model settings: defaults and the fast-tier fallback", () => {
  assert.deepEqual(llmSettings({}), { textModel: "gemini-flash-latest", textModelFast: "gemini-flash-latest", llmConcurrency: 2, llmTimeoutMs: 120000 });
  assert.deepEqual(llmSettings({ FRIDAY_TEXT_MODEL: "gemini-3.8-flash" }).textModelFast, "gemini-3.8-flash");
  assert.deepEqual(
    llmSettings({ FRIDAY_TEXT_MODEL: "a", FRIDAY_TEXT_MODEL_FAST: "b", FRIDAY_LLM_CONCURRENCY: "4", FRIDAY_LLM_TIMEOUT_MS: "5000" }),
    { textModel: "a", textModelFast: "b", llmConcurrency: 4, llmTimeoutMs: 5000 },
  );
  assert.equal(llmSettings({ FRIDAY_LLM_CONCURRENCY: "0" }).llmConcurrency, 2);
  assert.equal(llmSettings({ FRIDAY_LLM_CONCURRENCY: "nope" }).llmConcurrency, 2);
});

function stub(response: Partial<GenerateContentResponse>) {
  const calls: GenerateContentParameters[] = [];
  const fn = async (p: GenerateContentParameters) => {
    calls.push(p);
    return response as GenerateContentResponse;
  };
  return { calls, fn };
}

const ok: Partial<GenerateContentResponse> = {
  candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }, { text: '{"facts":' }, { text: "[]}" }] }, finishReason: FinishReason.STOP }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 30 },
  modelVersion: "gemini-3.8-flash",
};

test("a prompt with system, schema and signal maps to generateContent", async () => {
  const s = stub(ok);
  const signal = new AbortController().signal;
  const schema = { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] };
  const r = await new GeminiTextModel("k", s.fn).generate({ model: "gemini-flash-latest", system: "Be brief.", prompt: "hi", schema, temperature: 0.2, maxOutputTokens: 100 }, { signal });
  assert.deepEqual(s.calls, [{
    model: "gemini-flash-latest",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config: { systemInstruction: "Be brief.", temperature: 0.2, maxOutputTokens: 100, responseMimeType: "application/json", responseJsonSchema: schema, abortSignal: signal },
  }]);
  assert.deepEqual(r, { text: '{"facts":[]}', finishReason: "STOP", model: "gemini-3.8-flash", usage: { inputTokens: 12, outputTokens: 5, thoughtTokens: 30 } });
});

test("messages keep their order and roles; no schema means no JSON mode", async () => {
  const s = stub({ candidates: [{ content: { parts: [{ text: "fine" }] }, finishReason: FinishReason.MAX_TOKENS }] });
  const r = await new GeminiTextModel("k", s.fn).generate({ model: "m", messages: [{ role: "user", text: "a" }, { role: "model", text: "b" }, { role: "user", text: "c" }] });
  assert.deepEqual(s.calls[0], {
    model: "m",
    contents: [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b" }] }, { role: "user", parts: [{ text: "c" }] }],
    config: {},
  });
  assert.deepEqual(r, { text: "fine", finishReason: "MAX_TOKENS", model: "m", usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 } });
});

test("a blocked prompt carries the block reason", async () => {
  const s = stub({ promptFeedback: { blockReason: BlockedReason.PROHIBITED_CONTENT }, usageMetadata: { promptTokenCount: 3 } });
  const r = await new GeminiTextModel("k", s.fn).generate({ model: "m", prompt: "x" });
  assert.equal(r.blockReason, "PROHIBITED_CONTENT");
  assert.equal(r.text, "");
});

test("without a key the model is unavailable and nothing is called", async () => {
  const s = stub(ok);
  await assert.rejects(new GeminiTextModel("", s.fn).generate({ model: "m", prompt: "x" }), (e) => e instanceof LlmError && e.kind === "unavailable" && /GEMINI_API_KEY is not configured/.test(e.message));
  assert.equal(s.calls.length, 0);
});

const live = process.env.FRIDAY_LIVE_TESTS === "1" && !!process.env.GEMINI_API_KEY;

test("live: gemini answers a schema request through LlmService", { skip: live ? false : "set FRIDAY_LIVE_TESTS=1 and GEMINI_API_KEY" }, async () => {
  const lines: string[] = [];
  const { textModel } = llmSettings(process.env);
  const service = new LlmService({
    model: new GeminiTextModel(process.env.GEMINI_API_KEY!),
    models: { standard: textModel, fast: textModel },
    concurrency: 1,
    timeoutMs: 60000,
    log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) },
  });
  const r = await service.generate<{ colors: string[] }>("live-test", {
    system: "Answer with JSON only.",
    prompt: "List the three primary colors of light in lowercase.",
    schema: { type: "object", properties: { colors: { type: "array", items: { type: "string" } } }, required: ["colors"] },
  });
  assert.equal(r.model, textModel);
  assert.deepEqual([...r.json!.colors].sort(), ["blue", "green", "red"]);
  assert.ok(r.usage.inputTokens > 0 && r.usage.outputTokens > 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^llm: \\[live-test\\] ${textModel}.* ok in=\\d+ out=\\d+`));
  assert.ok(!lines[0].includes("primary colors"));
  console.log(lines[0]);
});
