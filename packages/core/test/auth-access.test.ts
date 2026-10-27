import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { McpServerStore } from "../src/tools/mcp-store.js";
import { migrate, migrations } from "../src/storage/db.js";
import { Auth } from "../src/auth/auth.js";
import { UserStore } from "../src/auth/users.js";
import { SessionStore } from "../src/auth/sessions.js";
import { adminOnly, isApiPath } from "../src/auth/access.js";
import { admin, member, quiet, startAuthApp } from "./auth-harness.js";

/** Requests only an admin may make, as [method, path]. */
const ADMIN_ONLY: [string, string][] = [
  ["GET", "/api/config"],
  ["PUT", "/api/config/global/X"],
  ["DELETE", "/api/config/core/X"],
  ["GET", "/api/mcp/servers"],
  ["POST", "/api/mcp/servers"],
  ["GET", "/api/keys"],
  ["POST", "/api/keys"],
  ["GET", "/api/devices"],
  ["POST", "/api/devices/pending/x/accept"],
  ["GET", "/api/oauth/connections"],
  ["GET", "/api/oauth/spotify/authorize"],
  ["GET", "/api/oauth/spotify/callback"],
  ["GET", "/api/jobs"],
  ["POST", "/api/jobs/brain/nightly/run"],
  ["GET", "/api/alerts"],
  ["GET", "/api/users"],
  ["POST", "/api/users/x/disable"],
  ["POST", "/api/modules/media/reload"],
  ["GET", "/api//config"],
  ["GET", "/api/config/"],
  ["GET", "/api/future-route-under/../config"],
];

/** Requests every user may make. */
const ANY_USER: [string, string][] = [
  ["GET", "/api/me"],
  ["GET", "/api/tools"],
  ["GET", "/api/modules"],
  ["GET", "/api/conversations"],
  ["GET", "/api/agents"],
  ["POST", "/api/chat"],
  ["GET", "/api/modules/brain/pages"],
  ["GET", "/api/modules/media/reload"],
  ["GET", "/api/nope"],
];

test("path rules: admin areas by segment, reload only as POST", () => {
  for (const [m, p] of ADMIN_ONLY) assert.ok(adminOnly(m, new URL(p, "http://x").pathname), `${m} ${p}`);
  for (const [m, p] of ANY_USER) assert.ok(!adminOnly(m, p), `${m} ${p}`);
  assert.ok(isApiPath("/api") && isApiPath("/api/x") && isApiPath("//api/x"));
  assert.ok(!isApiPath("/apiary") && !isApiPath("/auth/login") && !isApiPath("/"));
});

test("without a session every API path answers 401, also unknown ones; health and static paths stay open", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    for (const [method, path] of [...ADMIN_ONLY, ...ANY_USER]) {
      const res = await b.fetch(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 401, `${method} ${path}`);
      if (path === "/api/me") assert.deepEqual(await res.json(), { error: "unauthenticated" });
    }
    assert.equal((await b.fetch("/health")).status, 200);
    assert.notEqual((await b.fetch("/")).status, 401);
    assert.notEqual((await b.fetch("/chat/abc")).status, 401);
  } finally {
    await app.close();
  }
});

test("a member gets 403 on the household's setup and through to everything else", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const b = app.browser();
    await b.login();
    for (const [method, path] of ADMIN_ONLY) {
      const res = await b.fetch(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    assert.deepEqual(await (await b.fetch("/api/config")).json(), { error: "forbidden" });
    for (const [method, path] of ANY_USER) {
      const res = await b.fetch(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.ok(res.status !== 401 && res.status !== 403, `${method} ${path} answered ${res.status}`);
    }
    assert.equal((await b.fetch("/api/nope")).status, 404, "unknown paths are 404 with a session");
  } finally {
    await app.close();
  }
});

test("an admin passes the check on every path", async () => {
  const app = await startAuthApp({ person: admin });
  try {
    const b = app.browser();
    await b.login();
    for (const [method, path] of [...ADMIN_ONLY, ...ANY_USER]) {
      const res = await b.fetch(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.ok(res.status !== 401 && res.status !== 403, `${method} ${path} answered ${res.status}`);
    }
  } finally {
    await app.close();
  }
});

test("the cross-origin check runs before the session check", async () => {
  const app = await startAuthApp();
  try {
    const res = await app.browser().fetch("/api/chat", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: "{}" });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /cross-origin/);
  } finally {
    await app.close();
  }
});

test("in dev mode the local machine is the dev admin through the whole app", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const users = new UserStore(db);
  const sessions = new SessionStore(db, undefined);
  const auth = new Auth({ mode: { kind: "dev" }, users, sessions, publicUrl: () => undefined });
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, new McpServerStore(db, undefined), { log: quiet }), webDir: "/nonexistent", auth: { auth, users, sessions, publicUrl: () => undefined } }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const me = await fetch(`${base}/api/me`);
    assert.deepEqual(await me.json(), { id: "dev", name: "Dev", email: null, role: "admin", owner: false, authEnabled: false });
    assert.equal((await fetch(`${base}/api/config`)).status, 200);
    assert.equal((await fetch(`${base}/auth/login`, { redirect: "manual" })).status, 404);
  } finally {
    server.close();
  }
});
