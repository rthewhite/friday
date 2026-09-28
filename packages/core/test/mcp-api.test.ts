import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { migrate, migrations } from "../src/storage/db.js";
import { McpServerStore } from "../src/tools/mcp-store.js";
import { McpSource } from "../src/tools/mcp.js";
import { startMcpFixture, type McpFixture } from "./mcp-fixture.js";

const quiet = { log() {}, warn() {}, error() {} };
const TOKEN = "Bearer api-t0ken-secret";
const ENV_SECRET = "env-s3cret-value";

async function start(opts: { masterKey?: Buffer | null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const store = new McpServerStore(db, opts.masterKey === null ? undefined : (opts.masterKey ?? randomBytes(32)));
  const registry = new ToolRegistry(quiet);
  const mcp = new McpSource(registry, store, { log: quiet, timeoutMs: 2000 });
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  const server = createServer(createApp({ registry, host, mcp, mcpStore: store, webDir: "/nonexistent" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  /** Every response body, so tests can assert secrets never leave core. */
  const bodies: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return {
    call,
    bodies,
    mcp,
    close: async () => {
      await mcp.close();
      server.close();
      await once(server, "close");
    },
  };
}

const home = (f: McpFixture, extra: Record<string, unknown> = {}) => ({ name: "home", transport: "http", url: f.url, headers: [{ name: "Authorization", value: TOKEN, secret: true }], ...extra });

test("POST creates a server, connects it and GET lists it without secret values", async () => {
  const f = await startMcpFixture();
  const s = await start();
  try {
    const created = await s.call("POST", "/api/mcp/servers", home(f, { headers: [{ name: "Authorization", value: TOKEN, secret: true }, { name: "X-Client", value: "friday" }] }));
    assert.equal(created.status, 201);
    assert.equal(created.json.status, "loaded");
    assert.deepEqual(created.json.tools, ["home__turn_on", "home__turn_off"]);
    assert.deepEqual(created.json.headers, [{ name: "Authorization", secret: true }, { name: "X-Client", secret: false, value: "friday" }]);
    assert.equal(f.requests.at(-1)!.authorization, TOKEN);

    const listed = await s.call("GET", "/api/mcp/servers");
    assert.equal(listed.json.secretsEnabled, true);
    assert.equal(listed.json.servers.length, 1);
    const [entry] = listed.json.servers;
    assert.deepEqual([entry.name, entry.transport, entry.url, entry.enabled, entry.status], ["home", "http", f.url, true, "loaded"]);
    assert.ok(entry.updatedAt);
  } finally {
    await s.close();
    await f.close();
  }
});

test("invalid writes get 400, a duplicate 409, and a secret without a master key 503", async () => {
  const f = await startMcpFixture();
  const s = await start();
  const locked = await start({ masterKey: null });
  try {
    assert.equal((await s.call("POST", "/api/mcp/servers", "{nope")).status, 400);
    const badName = await s.call("POST", "/api/mcp/servers", home(f, { name: "home assistant" }));
    assert.equal(badName.status, 400);
    assert.match(badName.json.error, /name must/);
    const noUrl = await s.call("POST", "/api/mcp/servers", { name: "x", transport: "http" });
    assert.equal(noUrl.status, 400);
    assert.match(noUrl.json.error, /needs a url/);
    assert.equal((await s.call("POST", "/api/mcp/servers", home(f))).status, 201);
    assert.equal((await s.call("POST", "/api/mcp/servers", home(f))).status, 409);

    const refused = await locked.call("POST", "/api/mcp/servers", home(f));
    assert.equal(refused.status, 503);
    assert.match(refused.json.error, /FRIDAY_MASTER_KEY/);
    const after = await locked.call("GET", "/api/mcp/servers");
    assert.deepEqual(after.json, { secretsEnabled: false, servers: [] });
    // Plain headers still work without a key.
    assert.equal((await locked.call("POST", "/api/mcp/servers", home(f, { headers: [{ name: "X-Client", value: "friday" }] }))).status, 201);
  } finally {
    await s.close();
    await locked.close();
    await f.close();
  }
});

test("PUT keeps an unsent secret, cannot rename, and answers 404 for unknown servers", async () => {
  const f = await startMcpFixture();
  const s = await start();
  try {
    await s.call("POST", "/api/mcp/servers", home(f));
    const updated = await s.call("PUT", "/api/mcp/servers/home", { transport: "http", url: f.url, scheduling: "SILENT", include: ["turn_on"], headers: [{ name: "Authorization", secret: true }] });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.scheduling, "SILENT");
    assert.deepEqual(updated.json.tools, ["home__turn_on"]);
    assert.equal(f.requests.at(-1)!.authorization, TOKEN, "the stored token is still sent");

    const renamed = await s.call("PUT", "/api/mcp/servers/home", home(f, { name: "other" }));
    assert.equal(renamed.status, 400);
    assert.deepEqual((await s.call("GET", "/api/mcp/servers")).json.servers.map((x: { name: string }) => x.name), ["home"]);

    const missingSecret = await s.call("PUT", "/api/mcp/servers/home", { transport: "http", url: f.url, headers: [{ name: "X-New", secret: true }] });
    assert.equal(missingSecret.status, 400);
    assert.equal((await s.call("PUT", "/api/mcp/servers/ghost", home(f, { name: undefined }))).status, 404);
  } finally {
    await s.close();
    await f.close();
  }
});

test("DELETE removes the server from both listings; reconnect recovers a failed server", async () => {
  const f = await startMcpFixture();
  const s = await start();
  try {
    f.rejectWith = 401;
    const created = await s.call("POST", "/api/mcp/servers", home(f));
    assert.equal(created.status, 201);
    assert.equal(created.json.status, "failed");
    assert.deepEqual(created.json.tools, []);

    f.rejectWith = undefined;
    const back = await s.call("POST", "/api/mcp/servers/home/reconnect");
    assert.equal(back.status, 200);
    assert.equal(back.json.status, "loaded");
    assert.equal((await s.call("POST", "/api/mcp/servers/ghost/reconnect")).status, 404);

    // Disabled: reconnect is a no-op that reports disabled.
    await s.call("PUT", "/api/mcp/servers/home", { ...home(f, { name: undefined }), enabled: false });
    const disabled = await s.call("POST", "/api/mcp/servers/home/reconnect");
    assert.deepEqual([disabled.status, disabled.json.status, disabled.json.tools], [200, "disabled", []]);

    assert.equal((await s.call("DELETE", "/api/mcp/servers/home")).status, 204);
    assert.equal((await s.call("DELETE", "/api/mcp/servers/home")).status, 404);
    assert.deepEqual((await s.call("GET", "/api/mcp/servers")).json.servers, []);
    assert.deepEqual((await s.call("GET", "/api/modules")).json, []);
  } finally {
    await s.close();
    await f.close();
  }
});

test("/api/modules lists stored MCP servers as loaded, failed with an error, or disabled", async () => {
  const f = await startMcpFixture();
  const s = await start();
  try {
    await s.call("POST", "/api/mcp/servers", home(f));
    await s.call("POST", "/api/mcp/servers", { name: "down", transport: "http", url: "http://127.0.0.1:1/mcp" });
    await s.call("POST", "/api/mcp/servers", { name: "off", transport: "http", url: f.url, enabled: false });
    const mods = (await s.call("GET", "/api/modules")).json as { id: string; status: string; error?: string; tools: string[] }[];
    const by = Object.fromEntries(mods.map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(by), ["mcp:down", "mcp:home", "mcp:off"]);
    assert.equal(by["mcp:home"].status, "loaded");
    assert.deepEqual(by["mcp:home"].tools, ["home__turn_on", "home__turn_off"]);
    assert.equal(by["mcp:down"].status, "failed");
    assert.ok(by["mcp:down"].error);
    assert.deepEqual(by["mcp:down"].tools, []);
    assert.deepEqual({ ...by["mcp:off"] }, { id: "mcp:off", label: "off", description: "MCP server", status: "disabled", tools: [], ui: false });
  } finally {
    await s.close();
    await f.close();
  }
});

test("no response from the MCP or module APIs ever contains a secret value", async () => {
  const f = await startMcpFixture();
  const s = await start();
  try {
    await s.call("POST", "/api/mcp/servers", home(f));
    await s.call("POST", "/api/mcp/servers", { name: "local", transport: "stdio", command: "/nonexistent/binary", env: [{ name: "API_TOKEN", value: ENV_SECRET, secret: true }] });
    await s.call("PUT", "/api/mcp/servers/home", { transport: "http", url: f.url, headers: [{ name: "Authorization", value: TOKEN, secret: true }, { name: "X-Other", value: ENV_SECRET, secret: true }] });
    f.rejectWith = 403; // the fixture echoes the Authorization header in its error body
    await s.call("POST", "/api/mcp/servers/home/reconnect");
    await s.call("GET", "/api/mcp/servers");
    await s.call("GET", "/api/modules");
    assert.ok(s.bodies.length >= 6);
    for (const b of s.bodies) {
      assert.ok(!b.includes("api-t0ken-secret"), b);
      assert.ok(!b.includes(ENV_SECRET), b);
    }
  } finally {
    await s.close();
    await f.close();
  }
});
