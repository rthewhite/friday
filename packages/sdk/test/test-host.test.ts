import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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

test("defineTool keeps a tool's channels, and the test host calls as a channel would", async () => {
  const voiceOnly = defineModule({
    manifest: { id: "v", label: "V" },
    init(ctx) {
      ctx.defineTool({ name: "beep", description: "", channels: ["voice"], handler: () => ({ ok: true }) });
      ctx.defineTool({ name: "time", description: "", handler: () => ({ ok: true }) });
    },
  });
  const h = await createTestHost(voiceOnly);
  assert.deepEqual(h.registry.get("beep")?.channels, ["voice"]);
  assert.deepEqual(h.toolsIn("chat"), ["time"]);
  assert.deepEqual(h.toolsIn("voice"), ["beep", "time"]);
  assert.deepEqual((await h.call("beep", {}, { channel: "chat" })).result, { error: "unknown tool beep" });
  assert.deepEqual((await h.call("beep")).result, { ok: true });
});

const items = defineModule({
  manifest: { id: "hello", label: "Hello" },
  migrations: [{ version: 1, name: "items", up: "CREATE TABLE hello__items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" }],
  init(ctx) {
    ctx.defineTool({ name: "list_items", description: "", handler: () => ({ items: ctx.db.prepare("SELECT name FROM hello__items ORDER BY id").all().map((r) => r.name) }) });
    ctx.defineTool<{ name: string }>({ name: "add_item", description: "", handler: ({ name }) => ({ id: Number(ctx.db.prepare("INSERT INTO hello__items (name) VALUES (?)").run(name).lastInsertRowid) }) });
  },
});

test("the test host runs migrations in memory; tests seed and inspect through host.db", async () => {
  const cwd = readdirSync(".");
  const h = await createTestHost(items);
  h.db.prepare("INSERT INTO hello__items (name) VALUES (?)").run("seeded");
  assert.deepEqual((await h.call("list_items")).result, { items: ["seeded"] });
  await h.call("add_item", { name: "added" });
  assert.deepEqual(h.db.prepare("SELECT name FROM hello__items ORDER BY id").all().map((r) => r.name), ["seeded", "added"]);
  assert.throws(() => h.db.prepare("SELECT * FROM module_schema"), /module hello: database access refused/);
  assert.deepEqual(readdirSync("."), cwd);
  await h.dispose();
});

test("a query in init sees the rows its migrations wrote", async () => {
  let seen: unknown[] = [];
  const m = defineModule({
    manifest: { id: "hello", label: "Hello" },
    migrations: [{ version: 1, name: "items", up: "CREATE TABLE hello__items (name TEXT); INSERT INTO hello__items VALUES ('default')" }],
    init(ctx) { seen = ctx.db.prepare("SELECT name FROM hello__items").all().map((r) => r.name); },
  });
  await createTestHost(m);
  assert.deepEqual(seen, ["default"]);
});

test("a failing or non-isolated migration rejects createTestHost with the host's error, before init", async () => {
  let inits = 0;
  const broken = defineModule({
    manifest: { id: "hello", label: "Hello" },
    migrations: [
      { version: 1, name: "items", up: "CREATE TABLE hello__items (id INTEGER PRIMARY KEY)" },
      { version: 2, name: "oops", up: "CREATE TABLE items (id INTEGER PRIMARY KEY)" },
    ],
    init() { inits++; },
  });
  await assert.rejects(createTestHost(broken), /module hello: migration 2 "oops" failed: module hello: database access refused: create table items/);
  await assert.rejects(createTestHost({ ...broken, migrations: [broken.migrations![0], { ...broken.migrations![0] }] }), /module hello: duplicate migration version 1/);
  assert.equal(inits, 0);
});

test("modules without migrations may still use ctx.db lazily; bad ids fail at use", async () => {
  const m = defineModule({ manifest: { id: "bad-", label: "Bad" }, init() {} });
  const h = await createTestHost(m);
  assert.throws(() => h.db.exec("SELECT 1"), /module bad-: an id with "--" or a trailing "-" cannot own tables/);
  await assert.rejects(createTestHost({ ...m, migrations: [{ version: 1, name: "x", up: "SELECT 1" }] }), /cannot own tables/);
});

test("promptContext renders the module's providers per channel, and dispose drops them", async () => {
  const errors: string[] = [];
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.prompt.addContext(({ channel }) => `## Brain (${channel})\nThe user is Ray.`);
      ctx.prompt.addContext(() => { throw new Error("broken"); });
    },
  });
  const h = await createTestHost(m, { log: { log() {}, warn() {}, error: (...a) => void errors.push(a.join(" ")) } });
  assert.equal(h.promptContext("voice"), "## Brain (voice)\nThe user is Ray.");
  assert.equal(h.promptContext("chat"), "## Brain (chat)\nThe user is Ray.");
  assert.deepEqual(errors, ["prompt context provider of brain failed: broken", "prompt context provider of brain failed: broken"]);
  await h.dispose();
  assert.equal(h.promptContext("voice"), "");
});
