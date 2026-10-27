import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { migrate, migrations } from "../src/storage/db.js";
import { Auth } from "../src/auth/auth.js";
import { UserStore } from "../src/auth/users.js";
import { SessionStore } from "../src/auth/sessions.js";
import { UserConnections } from "../src/auth/connections.js";
import { startHarness, StubSession, waitFor } from "./helpers.js";

const quiet = { log() {}, warn() {} };

function authFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const users = new UserStore(db);
  const sessions = new SessionStore(db, randomBytes(32));
  const settings = { issuer: "https://auth.example/", clientId: "c", clientSecret: "s", userGroup: "friday-users", adminGroup: "friday-admins" };
  const auth = new Auth({ mode: { kind: "oidc", oidc: settings }, users, sessions, publicUrl: () => "http://localhost", log: quiet });
  const r = users.provision({ issuer: settings.issuer, subject: "s1", email: "sanne@example.org", name: "Sanne", role: "member" });
  assert.ok(r.ok);
  const token = sessions.create(r.user.id, "rt");
  return { auth, users, sessions, user: r.user, cookie: `friday_session=${token}`, userConnections: new UserConnections() };
}

/** Open a socket with headers; resolves "open" or the HTTP status of a refused upgrade. */
async function attempt(url: string, headers: Record<string, string>): Promise<{ ws?: WebSocket; status?: number }> {
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once("error", (e) => (/Unexpected server response/.test(e.message) ? undefined : reject(e)));
  });
}

test("a browser with a valid session opens the Talk socket, and it belongs to that user", async () => {
  const f = authFixture();
  const h = await startHarness({ auth: f.auth, userConnections: f.userConnections });
  try {
    const host = new URL(h.url).host;
    const r = await attempt(h.url, { cookie: f.cookie, origin: `http://${host}` });
    assert.ok(r.ws, `refused with ${r.status}`);
    await waitFor(() => StubSession.instances.length === 1);
    assert.deepEqual(StubSession.instances[0].user, { id: f.user.id, name: "Sanne" }, "the session is for that user");
    assert.equal(f.userConnections.count(f.user.id), 1);
    r.ws!.close();
    await waitFor(() => f.userConnections.count(f.user.id) === 0);
  } finally {
    await h.close();
  }
});

test("without a session the upgrade is refused with 401 before any session opens", async () => {
  const f = authFixture();
  const h = await startHarness({ auth: f.auth, userConnections: f.userConnections });
  try {
    assert.equal((await attempt(h.url, {})).status, 401);
    assert.equal((await attempt(h.url, { cookie: "friday_session=forged" })).status, 401);
    f.sessions.endUser(f.user.id);
    assert.equal((await attempt(h.url, { cookie: f.cookie })).status, 401, "ended session");
    assert.equal(StubSession.instances.length, 0);
  } finally {
    await h.close();
  }
});

test("a page on another origin is refused with 403, even with the user's cookie", async () => {
  const f = authFixture();
  const h = await startHarness({ auth: f.auth });
  try {
    assert.equal((await attempt(h.url, { cookie: f.cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await attempt(h.url, { cookie: f.cookie, origin: "null" })).status, 403);
    assert.equal(StubSession.instances.length, 0);
  } finally {
    await h.close();
  }
});

test("an empty device parameter is device authentication, never a browser session", async () => {
  const f = authFixture();
  const h = await startHarness({ auth: f.auth });
  try {
    const ws = new WebSocket(`${h.url}?device=`, { headers: { cookie: f.cookie } });
    const [code] = (await once(ws, "close")) as [number];
    assert.ok(code === 4400 || code === 4401, `closed with ${code}`);
    assert.equal(StubSession.instances.length, 0);
  } finally {
    await h.close();
  }
});

test("disabling the user closes their open Talk socket with 4401 and its session", async () => {
  const f = authFixture();
  const h = await startHarness({ auth: f.auth, userConnections: f.userConnections });
  try {
    const r = await attempt(h.url, { cookie: f.cookie });
    assert.ok(r.ws);
    await waitFor(() => StubSession.instances.length === 1);
    const closed = once(r.ws!, "close");
    assert.equal(f.userConnections.closeUser(f.user.id), 1);
    const [code] = (await closed) as [number];
    assert.equal(code, 4401);
    await waitFor(() => StubSession.instances[0].closed > 0);
  } finally {
    await h.close();
  }
});
