import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolRegistry } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { McpServerStore, parseServerInput } from "../src/tools/mcp-store.js";
import { McpSource, sanitize, toResult } from "../src/tools/mcp.js";
import { startMcpFixture } from "./mcp-fixture.js";

const quiet = { log() {}, error() {} };
const TOKEN = "Bearer fixture-t0ken-value";

function setup(opts: { timeoutMs?: number } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const store = new McpServerStore(db, randomBytes(32));
  const registry = new ToolRegistry(quiet);
  const logs: string[] = [];
  const log = { log: (...a: unknown[]) => logs.push(a.join(" ")), error: (...a: unknown[]) => logs.push(a.join(" ")) };
  const src = new McpSource(registry, store, { log, timeoutMs: opts.timeoutMs });
  const add = (body: Record<string, unknown>) => store.create(parseServerInput(body));
  const put = (body: Record<string, unknown>) => store.update(parseServerInput(body));
  return { store, registry, src, logs, add, put };
}

test("fixture serves tools to a plain SDK client", async () => {
  const f = await startMcpFixture(["a", "b"]);
  try {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(f.url)));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["a", "b"]);
    await client.close();
  } finally {
    await f.close();
  }
});

test("no store or an empty store registers nothing", async () => {
  const bare = new McpSource(new ToolRegistry(quiet), undefined, { log: quiet });
  await bare.load();
  assert.deepEqual(bare.servers(), []);
  const { src, registry } = setup();
  await src.load();
  assert.deepEqual(src.servers(), []);
  assert.deepEqual(registry.names(), []);
});

test("an unreachable server fails alone; the other loads with the secret header it was given", async () => {
  const f = await startMcpFixture();
  const { src, registry, logs, add } = setup();
  try {
    add({ name: "home", transport: "http", url: f.url, headers: [{ name: "Authorization", value: TOKEN, secret: true }] });
    add({ name: "down", transport: "http", url: "http://127.0.0.1:1/mcp" });
    await src.load();
    const [down, home] = src.servers();
    assert.equal(down.status, "failed");
    assert.match(down.error!, /^fetch failed \(.+\)$/, "the cause is included");
    assert.deepEqual(down.tools, []);
    assert.deepEqual(home, { name: "home", status: "loaded", tools: ["home__turn_on", "home__turn_off"] });
    assert.deepEqual(registry.names(), ["home__turn_on", "home__turn_off"]);
    assert.ok(f.requests.every((h) => h.authorization === TOKEN));
    assert.ok(logs.some((l) => l.includes('server "down" failed to load')));
    const out = await registry.callTool("home__turn_on", {});
    assert.deepEqual(out.result, { result: { called: "turn_on" } });
  } finally {
    await src.close();
    await f.close();
  }
});

test("a disabled server is not connected and registers no tools", async () => {
  const f = await startMcpFixture();
  const { src, registry, add } = setup();
  try {
    add({ name: "home", transport: "http", url: f.url, enabled: false });
    await src.load();
    assert.deepEqual(src.servers(), [{ name: "home", status: "disabled", tools: [] }]);
    assert.deepEqual(registry.names(), []);
    assert.equal(f.requests.length, 0);
  } finally {
    await src.close();
    await f.close();
  }
});

test("include, exclude, prefix and scheduling shape the registered tools", async () => {
  const f = await startMcpFixture(["turn_on", "turn_off", "delete_all"]);
  const { src, registry, add } = setup();
  try {
    add({ name: "a", transport: "http", url: f.url, include: ["turn_on"] });
    add({ name: "b", transport: "http", url: f.url, exclude: ["delete_all"], prefix: "ha", scheduling: "SILENT" });
    await src.load();
    assert.deepEqual(registry.names("mcp:a"), ["a__turn_on"]);
    assert.deepEqual(registry.names("mcp:b"), ["ha__turn_on", "ha__turn_off"]);
    assert.equal(registry.get("ha__turn_on")!.scheduling, "SILENT");
    assert.equal(registry.get("a__turn_on")!.scheduling, undefined);
    assert.equal(registry.get("a__turn_on")!.description, "turn_on tool");
  } finally {
    await src.close();
    await f.close();
  }
});

test("a stdio server is spawned with its args and env merged into the process environment", async () => {
  const { src, registry, add } = setup();
  try {
    add({ name: "local", transport: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./mcp-stdio-fixture.mjs", import.meta.url)), "from args"], env: [{ name: "FIXTURE_TOOL", value: "from_env", secret: true }] });
    await src.load();
    assert.deepEqual(src.servers()[0], { name: "local", status: "loaded", tools: ["local__from_env"] });
    assert.equal(registry.get("local__from_env")!.description, "from args");
  } finally {
    await src.close();
  }
});

test("apply reconnects only the changed server, serializes per server and forgets deleted ones", async () => {
  const home = await startMcpFixture(["turn_on", "turn_off"]);
  const fs = await startMcpFixture(["read"]);
  const { src, registry, logs, add, put, store } = setup();
  try {
    add({ name: "home", transport: "http", url: home.url });
    add({ name: "fs", transport: "http", url: fs.url });
    await src.load();
    const fsRequests = fs.requests.length;

    put({ name: "home", transport: "http", url: home.url, include: ["turn_on"] });
    assert.deepEqual(await src.apply("home"), { name: "home", status: "loaded", tools: ["home__turn_on"] });
    assert.equal(fs.requests.length, fsRequests, "fs is not touched");
    assert.deepEqual(registry.names("mcp:fs"), ["fs__read"]);

    // Two saves racing: both run, one after the other, and end with a single registration.
    const [a, b] = await Promise.all([src.apply("home"), src.apply("home")]);
    assert.equal(a!.status, "loaded");
    assert.equal(b!.status, "loaded");
    assert.deepEqual(registry.names("mcp:home"), ["home__turn_on"]);
    assert.ok(!logs.some((l) => l.includes("duplicate tool")));

    store.delete("home");
    assert.equal(await src.apply("home"), undefined);
    assert.deepEqual(registry.names("mcp:home"), []);
    assert.deepEqual(src.servers().map((s) => s.name), ["fs"]);
  } finally {
    await src.close();
    await home.close();
    await fs.close();
  }
});

test("a server that never answers fails with a timeout and does not block load", async () => {
  const f = await startMcpFixture();
  f.hangListTools = true;
  const { src, registry, add } = setup({ timeoutMs: 50 });
  try {
    add({ name: "slow", transport: "http", url: f.url });
    await src.load();
    assert.deepEqual(src.servers(), [{ name: "slow", status: "failed", error: "timed out after 50ms", tools: [] }]);
    assert.deepEqual(registry.names(), []);
  } finally {
    await src.close();
    await f.close();
  }
});

test("close waits for a reconnect in flight and leaves nothing connected", async () => {
  const f = await startMcpFixture();
  const { src, registry, add, put } = setup({ timeoutMs: 300 });
  try {
    add({ name: "home", transport: "http", url: f.url });
    await src.load();
    f.hangListTools = true;
    put({ name: "home", transport: "http", url: f.url, include: ["turn_on"] });
    const seen = f.requests.length;
    const inFlight = src.apply("home");
    const queued = src.apply("home");
    // Close only once the reconnect is really talking to the (hanging) server.
    while (f.requests.length === seen) await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    await src.close();
    const waited = Date.now() - started;
    assert.ok(waited >= 200, `close waited for the in-flight connect to time out (${waited}ms)`);
    assert.ok(waited < 550, `the queued apply did not connect again (${waited}ms)`);
    assert.equal((await inFlight)!.status, "failed");
    assert.equal((await queued)!.status, "failed");
    assert.deepEqual(src.servers(), []);
    assert.deepEqual(registry.names(), []);
    assert.equal(await src.apply("home"), undefined, "apply after close does nothing");
  } finally {
    await f.close();
  }
});

test("a rejected connection is reported without the secret, in state and in logs", async () => {
  const f = await startMcpFixture();
  f.rejectWith = 401;
  const { src, logs, add } = setup();
  try {
    add({ name: "home", transport: "http", url: f.url, headers: [{ name: "Authorization", value: TOKEN, secret: true }] });
    await src.load();
    const [s] = src.servers();
    assert.equal(s.status, "failed");
    assert.match(s.error!, /Error POSTing to endpoint: rejected: \*\*\*/);
    assert.equal(f.requests[0].authorization, TOKEN, "the token was sent");
    for (const text of [s.error!, ...logs]) assert.ok(!text.includes("fixture-t0ken-value"), text);

    // Reconnect once the server accepts again.
    f.rejectWith = undefined;
    assert.equal((await src.apply("home"))!.status, "loaded");
  } finally {
    await src.close();
    await f.close();
  }
});

test("a wrong master key fails only the server with secrets, without logging the value", async () => {
  const f = await startMcpFixture();
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  new McpServerStore(db, randomBytes(32)).create(parseServerInput({ name: "home", transport: "http", url: f.url, headers: [{ name: "Authorization", value: TOKEN, secret: true }] }));
  new McpServerStore(db, randomBytes(32)).create(parseServerInput({ name: "plain", transport: "http", url: f.url }));
  const logs: string[] = [];
  const src = new McpSource(new ToolRegistry(quiet), new McpServerStore(db, randomBytes(32)), { log: { log() {}, error: (...a: unknown[]) => logs.push(a.join(" ")) } });
  try {
    await src.load();
    const [home, plain] = src.servers();
    assert.deepEqual([home.status, plain.status], ["failed", "loaded"]);
    assert.match(home.error!, /secret header "Authorization" cannot be decrypted/);
    assert.ok(logs.some((l) => l.includes('server "home" failed')));
    assert.ok(logs.every((l) => !l.includes("fixture-t0ken-value")));
    assert.equal(f.requests.filter((h) => h.authorization).length, 0, "nothing is sent for the undecryptable server");
  } finally {
    await src.close();
    await f.close();
  }
});

test("updating a server leaves an earlier declarations snapshot unchanged", async () => {
  const f = await startMcpFixture(["turn_on", "turn_off"]);
  const { src, registry, add, put } = setup();
  try {
    add({ name: "home", transport: "http", url: f.url });
    await src.load();
    const snapshot = registry.declarations();
    put({ name: "home", transport: "http", url: f.url, include: ["turn_off"] });
    await src.apply("home");
    assert.deepEqual(snapshot.map((d) => d.name), ["home__turn_on", "home__turn_off"]);
    assert.deepEqual(registry.declarations().map((d) => d.name), ["home__turn_off"]);
  } finally {
    await src.close();
    await f.close();
  }
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
