import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule } from "../src/index.js";
import { createTestHost } from "../src/test.js";

const m = defineModule({
  manifest: { id: "m", label: "M" },
  init(ctx) {
    ctx.http.route("GET", "search", (req, res) => res.json({ q: req.query.get("q") }));
    ctx.http.route("POST", "items/:id", async (req, res, params) => res.status(201).json({ id: params.id, body: await req.json() }));
    ctx.http.route("GET", "nothing", () => {});
  },
});

test("test host records routes and serves them in memory", async () => {
  const h = await createTestHost(m);
  assert.deepEqual(h.routes, ["GET search", "POST items/:id", "GET nothing"]);
  assert.deepEqual(await h.request("GET", "search?q=hi"), { status: 200, body: { q: "hi" }, contentType: "application/json" });
  assert.deepEqual(await h.request("POST", "items/9", { a: 1 }), { status: 201, body: { id: "9", body: { a: 1 } }, contentType: "application/json" });
  assert.equal((await h.request("GET", "nothing")).status, 204);
  assert.equal((await h.request("GET", "missing")).status, 404);
  assert.equal((await h.request("DELETE", "search")).status, 405);
});
