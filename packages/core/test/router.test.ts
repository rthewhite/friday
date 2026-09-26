import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { compilePath, RouteTable } from "@friday/sdk";
import { Router, sendJson } from "../src/router.js";

test("compilePath matches literal and :param segments", () => {
  const m = compilePath("items/:id/tags/:tag");
  assert.deepEqual(m("/items/42/tags/a%20b"), { id: "42", tag: "a b" });
  assert.equal(m("/items/42"), null);
  assert.equal(m("/items/42/tags/x/extra"), null);
  assert.deepEqual(compilePath("")("/"), {});
  assert.deepEqual(compilePath("/search/")("search"), {});
});

test("RouteTable distinguishes no match from method mismatch", () => {
  const t = new RouteTable();
  t.add({ method: "GET", path: "a", handler: () => {} });
  assert.equal(t.find("GET", "/b"), null);
  assert.equal(t.find("POST", "/a"), "method");
  assert.ok(t.find("GET", "/a"));
});

test("Router dispatches with params and answers 405 on method mismatch", async () => {
  const r = new Router()
    .add("GET", "/items/:id", (_q, res, params, url) => sendJson(res, { id: params.id, q: url.searchParams.get("q") }))
    .add("POST", "/items", (_q, res) => sendJson(res, { created: true }, 201));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (!(await r.dispatch(req, res, url))) { res.statusCode = 404; res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/items/7?q=x`)).json(), { id: "7", q: "x" });
    const created = await fetch(`${base}/items`, { method: "POST" });
    assert.equal(created.status, 201);
    assert.equal((await fetch(`${base}/items/7`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
