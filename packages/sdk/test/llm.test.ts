import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRequest, defineModule, LlmError, parseOutput, RAW_OUTPUT_LIMIT, type LlmErrorKind, type ModuleContext } from "../src/index.js";
import { createTestHost } from "../src/test.js";

const facts = { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] };

const kind = (k: LlmErrorKind) => (e: unknown) => e instanceof LlmError && e.kind === k;

test("checkRequest accepts exactly one of prompt and messages", () => {
  checkRequest({ prompt: "hi" });
  checkRequest({ messages: [{ role: "user", text: "hi" }, { role: "model", text: "hello" }] });
  assert.throws(() => checkRequest({ prompt: "hi", messages: [{ role: "user", text: "x" }] }), kind("invalid_request"));
  assert.throws(() => checkRequest({}), kind("invalid_request"));
  assert.throws(() => checkRequest({ messages: [] }), kind("invalid_request"));
  assert.throws(() => checkRequest({ messages: [{ role: "system" as "user", text: "x" }] }), kind("invalid_request"));
  assert.throws(() => checkRequest({ prompt: "x", model: "huge" as "fast" }), kind("invalid_request"));
});

test("checkRequest accepts a non-negative maxRetryWaitMs and rejects anything else", () => {
  checkRequest({ prompt: "x", maxRetryWaitMs: 0 });
  checkRequest({ prompt: "x", maxRetryWaitMs: 5000 });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60" as unknown as number]) {
    assert.throws(() => checkRequest({ prompt: "x", maxRetryWaitMs: bad }), kind("invalid_request"));
  }
});

test("checkRequest rejects a schema that does not compile", () => {
  checkRequest({ prompt: "x", schema: facts });
  assert.throws(() => checkRequest({ prompt: "x", schema: { type: "nonsense" } }), (e) => kind("invalid_request")(e) && /not a valid JSON Schema/.test((e as Error).message));
  assert.throws(() => checkRequest({ prompt: "x", schema: [] as unknown as Record<string, unknown> }), kind("invalid_request"));
});

test("checkRequest tolerates Gemini-specific keywords", () => {
  checkRequest({ prompt: "x", schema: { type: "object", properties: { a: { type: "string", format: "date-time" } }, propertyOrdering: ["a"] } });
});

test("parseOutput returns conforming JSON, including an empty result", () => {
  assert.deepEqual(parseOutput(facts, '{"facts": ["a"]}'), { facts: ["a"] });
  assert.deepEqual(parseOutput(facts, '{"facts": []}', "STOP"), { facts: [] });
  assert.deepEqual(parseOutput({ type: "array" }, "[]"), []);
});

test("non-conforming output is invalid_output with the raw text", () => {
  assert.throws(() => parseOutput(facts, '{"fact": "x"}'), (e) => {
    assert.ok(e instanceof LlmError);
    assert.equal(e.kind, "invalid_output");
    assert.equal(e.raw, '{"fact": "x"}');
    assert.match(e.message, /does not match the schema/);
    return true;
  });
  assert.throws(() => parseOutput(facts, "Sure! Here you go"), (e) => kind("invalid_output")(e) && (e as LlmError).raw === "Sure! Here you go");
});

test("truncated output is invalid_output even when it parses", () => {
  assert.throws(() => parseOutput(facts, '{"facts": []}', "MAX_TOKENS"), (e) => kind("invalid_output")(e) && /truncated/.test((e as Error).message));
});

test("raw text is capped", () => {
  const long = "x".repeat(RAW_OUTPUT_LIMIT + 50);
  assert.throws(() => parseOutput(facts, long), (e) => (e as LlmError).raw?.length === RAW_OUTPUT_LIMIT);
});

test("the compiled validator is reused per schema object", () => {
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  for (let i = 0; i < 3; i++) assert.deepEqual(parseOutput(schema, `{"n": ${i}}`), { n: i });
});

// The README example, verbatim.
const factsSchema = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"],
};

async function extractFacts(ctx: ModuleContext, transcript: string, signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    const r = await ctx.llm.generate<{ facts: string[] }>({
      system: "Extract durable facts about the user. Return an empty list when there are none.",
      prompt: transcript,             // or messages: [{ role: "user", text }, { role: "model", text }, ...]
      schema: factsSchema,            // optional; the answer is parsed and validated, and returned as r.json
      model: "fast",                  // "standard" (default) or "fast"
      signal,                         // aborting rejects with "cancelled"
    });
    return r.json!.facts;             // r.text, r.model and r.usage are always present
  } catch (e) {
    if (e instanceof LlmError && e.kind === "unavailable") return undefined;   // try again on the next run
    if (e instanceof LlmError && e.kind === "invalid_output") ctx.log.warn(`bad answer: ${e.message}`);
    throw e;
  }
}

test("the README example works against the test host", async () => {
  let ctx: ModuleContext | undefined;
  const brain = defineModule({ manifest: { id: "brain", label: "Brain" }, init: (c) => void (ctx = c) });
  const h = await createTestHost(brain, { llm: (req) => (req.schema ? '{"facts": []}' : "A short summary.") });
  assert.deepEqual(await extractFacts(ctx!, "hello"), []);
  assert.equal(h.llmRequests[0].system, "Extract durable facts about the user. Return an empty list when there are none.");
  assert.equal(h.llmRequests[0].model, "fast");

  const bad = await createTestHost(brain, { llm: () => "not json" });
  await assert.rejects(extractFacts(ctx!, "hello"), (e) => e instanceof LlmError && e.kind === "invalid_output");
  assert.equal(bad.llmRequests.length, 1);

  await createTestHost(brain);
  assert.equal(await extractFacts(ctx!, "hello"), undefined);

  const ac = new AbortController();
  ac.abort();
  await createTestHost(brain, { llm: () => '{"facts": []}' });
  await assert.rejects(extractFacts(ctx!, "hello", ac.signal), (e) => e instanceof LlmError && e.kind === "cancelled");
});
