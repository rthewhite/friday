import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, LlmError, Type, type ModuleContext } from "../src/index.js";
import { createTestHost } from "../src/test.js";

const hello = defineModule({
  manifest: {
    id: "hello",
    label: "Hello",
    config: [{ key: "GREETING", required: true }, { key: "SUFFIX" }],
  },
  init(ctx) {
    ctx.defineTool<{ name: string }>({
      name: "greet",
      description: "Greets",
      parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ["name"] },
      handler: ({ name }) => ({ text: `${ctx.config.require("GREETING")} ${name}${ctx.config.get("SUFFIX") ?? ""}` }),
    });
    ctx.log.log("ready");
  },
});

test("a module's tool is callable without a server", async () => {
  const lines: string[] = [];
  const h = await createTestHost(hello, {
    env: { GREETING: "Hi" },
    log: { log: (...a) => lines.push(a.join(" ")), warn() {}, error() {} },
  });
  assert.deepEqual(h.tools, ["greet"]);
  assert.deepEqual(await h.call("greet", { name: "Ray" }), { result: { text: "Hi Ray" }, scheduling: "INTERRUPT" });
  assert.deepEqual(lines, ["[hello] ready"]);
  assert.deepEqual(h.registry.list()[0].owner, "hello");
});

test("optional config falls back to undefined and process.env is not consulted", async () => {
  process.env.SUFFIX = "!!!";
  try {
    const h = await createTestHost(hello, { env: { GREETING: "Yo" } });
    assert.equal((await h.call("greet", { name: "x" })).result.text, "Yo x");
  } finally {
    delete process.env.SUFFIX;
  }
});

test("missing required config rejects with the host's error", async () => {
  await assert.rejects(createTestHost(hello, { env: {} }), /module hello: missing required config GREETING/);
});

test("dispose is forwarded", async () => {
  let disposed = 0;
  const m = defineModule({ manifest: { id: "d", label: "D" }, init() {}, dispose: () => void disposed++ });
  const h = await createTestHost(m);
  await h.dispose();
  assert.equal(disposed, 1);
});

const factsSchema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };
const extractor = defineModule({
  manifest: { id: "extractor", label: "Extractor" },
  init(ctx) {
    ctx.defineTool<{ text: string }>({
      name: "extract",
      description: "Extracts facts",
      handler: async ({ text }) => {
        try {
          const r = await ctx.llm.generate<{ facts: string[] }>({ system: "Extract facts.", prompt: text, schema: factsSchema });
          return { facts: r.json!.facts, model: r.model };
        } catch (e) {
          if (e instanceof LlmError) return { failed: e.kind, raw: e.raw };
          throw e;
        }
      },
    });
  },
});

test("a fake model answer is validated and returned as json", async () => {
  const h = await createTestHost(extractor, { llm: () => '{"facts": ["sky is blue"]}' });
  assert.deepEqual((await h.call("extract", { text: "the sky is blue" })).result, { facts: ["sky is blue"], model: "fake-standard" });
});

test("a non-conforming fake answer is invalid_output", async () => {
  const h = await createTestHost(extractor, { llm: () => '{"fact":"x"}' });
  assert.deepEqual((await h.call("extract", { text: "t" })).result, { failed: "invalid_output", raw: '{"fact":"x"}' });
});

test("requests reaching the fake are recorded", async () => {
  const h = await createTestHost(extractor, { llm: async () => '{"facts": []}' });
  await h.call("extract", { text: "one" });
  await h.call("extract", { text: "two" });
  assert.deepEqual(h.llmRequests.map((r) => [r.system, r.prompt, r.schema]), [
    ["Extract facts.", "one", factsSchema],
    ["Extract facts.", "two", factsSchema],
  ]);
});

test("the fake can throw LlmError kinds, and invalid requests never reach it", async () => {
  let ctx: ModuleContext | undefined;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init: (c) => void (ctx = c) });
  const h = await createTestHost(m, { llm: () => { throw new LlmError("blocked", "blocked by provider", { reason: "SAFETY" }); } });
  await assert.rejects(ctx!.llm.generate({ prompt: "x" }), (e) => e instanceof LlmError && e.kind === "blocked" && e.reason === "SAFETY");
  await assert.rejects(ctx!.llm.generate({ prompt: "x", messages: [{ role: "user", text: "y" }] }), (e) => e instanceof LlmError && e.kind === "invalid_request");
  assert.equal(h.llmRequests.length, 1);
});

test("without a fake, ctx.llm is unavailable", async () => {
  const h = await createTestHost(extractor);
  assert.deepEqual((await h.call("extract", { text: "t" })).result, { failed: "unavailable", raw: undefined });
  assert.deepEqual(h.llmRequests, []);
});
