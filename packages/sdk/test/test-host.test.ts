import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, Type } from "../src/index.js";
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
