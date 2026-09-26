import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@friday/sdk";
import { McpSource, sanitize, toResult } from "../src/tools/mcp.js";

const quiet = { log() {}, error() {} };

test("missing config file is silent, invalid file throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-mcp-"));
  const src = new McpSource(new ToolRegistry(quiet), quiet);
  await src.load(join(dir, "missing.json"));
  assert.deepEqual(src.servers(), []);
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{nope");
  await assert.rejects(src.load(bad), /invalid .*bad\.json/);
});

test("server without transport fails alone and is logged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-mcp-"));
  const cfg = join(dir, "mcp.json");
  await writeFile(cfg, JSON.stringify({ servers: { broken: { include: ["x"] } } }));
  const errors: string[] = [];
  const src = new McpSource(new ToolRegistry(quiet), { log() {}, error: (...a) => errors.push(a.join(" ")) });
  await src.load(cfg);
  assert.deepEqual(src.servers(), []);
  assert.ok(errors.some((e) => e.includes('server "broken" failed to load') && e.includes("command") && e.includes("url")));
});

test("toResult flattens structured, JSON text, plain text and errors", () => {
  assert.deepEqual(toResult({ structuredContent: { a: 1 }, content: [] } as any), { a: 1 });
  assert.deepEqual(toResult({ content: [{ type: "text", text: '{"x":2}' }] } as any), { result: { x: 2 } });
  assert.deepEqual(toResult({ content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png" }] } as any), { result: "hi", attachments: ["[image image/png]"] });
  assert.deepEqual(toResult({ isError: true, content: [{ type: "text", text: "bad" }] } as any), { result: "bad", error: "bad" });
  assert.deepEqual(toResult({ isError: true, content: [] } as any), { error: "tool reported an error" });
});

test("sanitize replaces invalid characters and leading digits", () => {
  assert.equal(sanitize("turn on/off"), "turn_on_off");
  assert.equal(sanitize("1abc"), "_abc");
  assert.equal(sanitize("ok.name:x-y"), "ok.name:x-y");
});
