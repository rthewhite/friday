import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule } from "../src/index.js";
import { createTestHost } from "../src/test.js";

test("test host provides in-memory storage to the module", async () => {
  const m = defineModule({
    manifest: { id: "m", label: "M" },
    init(ctx) {
      ctx.defineTool({ name: "bump", description: "", handler: async () => { const n = ((await ctx.storage.get<number>("n")) ?? 0) + 1; await ctx.storage.set("n", n); return { n }; } });
    },
  });
  const h = await createTestHost(m);
  await h.call("bump");
  assert.deepEqual((await h.call("bump")).result, { n: 2 });
  assert.deepEqual(await h.storage.list(), ["n"]);
  assert.equal(await h.storage.get("n"), 2);
});

test("config reads go through the resolver lazily", async () => {
  const env: Record<string, string | undefined> = {};
  const m = defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { ctx.defineTool({ name: "k", description: "", handler: () => ({ v: ctx.config.get("K") }) }); } });
  const h = await createTestHost(m, { env });
  assert.deepEqual((await h.call("k")).result, { v: undefined });
  env.K = "later";
  assert.deepEqual((await h.call("k")).result, { v: "later" });
});
