/** Text model settings, and a live check of the Gemini adapter through LlmService (the adapter's unit tests are in llm-gemini-adapter.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { llmSettings } from "../src/config.js";
import { GeminiAdapter } from "../src/llm/gemini.js";
import { LlmService } from "../src/llm/service.js";

test("text model settings: defaults and the fast-tier fallback", () => {
  assert.deepEqual(llmSettings({}), { textModel: "gemini-flash-latest", textModelFast: "gemini-flash-latest", llmConcurrency: 2, llmTimeoutMs: 120000, llmMaxRetryWaitMs: 60000 });
  assert.deepEqual(llmSettings({ FRIDAY_TEXT_MODEL: "gemini-3.8-flash" }).textModelFast, "gemini-3.8-flash");
  assert.deepEqual(
    llmSettings({ FRIDAY_TEXT_MODEL: "a", FRIDAY_TEXT_MODEL_FAST: "b", FRIDAY_LLM_CONCURRENCY: "4", FRIDAY_LLM_TIMEOUT_MS: "5000", FRIDAY_LLM_MAX_RETRY_WAIT_MS: "0" }),
    { textModel: "a", textModelFast: "b", llmConcurrency: 4, llmTimeoutMs: 5000, llmMaxRetryWaitMs: 0 },
  );
  assert.equal(llmSettings({ FRIDAY_LLM_CONCURRENCY: "0" }).llmConcurrency, 2);
  assert.equal(llmSettings({ FRIDAY_LLM_CONCURRENCY: "nope" }).llmConcurrency, 2);
  assert.equal(llmSettings({ FRIDAY_LLM_MAX_RETRY_WAIT_MS: "-5" }).llmMaxRetryWaitMs, 60000);
});

const live = process.env.FRIDAY_LIVE_TESTS === "1" && !!process.env.GEMINI_API_KEY;

test("live: gemini answers a schema request through LlmService", { skip: live ? false : "set FRIDAY_LIVE_TESTS=1 and GEMINI_API_KEY" }, async () => {
  const lines: string[] = [];
  const { textModel } = llmSettings(process.env);
  const service = new LlmService({
    model: new GeminiAdapter(process.env.GEMINI_API_KEY!),
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
