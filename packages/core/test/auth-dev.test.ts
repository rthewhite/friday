import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { Auth, requestUser } from "../src/auth/auth.js";
import { UserStore } from "../src/auth/users.js";
import { readCookie, serializeCookie, sessionCookieName } from "../src/auth/cookies.js";

const quiet = { log() {} };

function devAuth() {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const users = new UserStore(db);
  return { users, auth: new Auth({ mode: { kind: "dev" }, users, publicUrl: () => undefined }) };
}

const req = (remoteAddress: string, headers: Record<string, string> = { host: "localhost:5173" }) => ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

test("without auth configured, the local machine is the dev admin", async () => {
  const { auth } = devAuth();
  assert.equal(auth.enabled, false);
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const r = req(a);
    const found = await auth.authenticate(r);
    assert.deepEqual({ id: found?.user.id, name: found?.user.name, role: found?.user.role }, { id: "dev", name: "Dev", role: "admin" }, a);
    assert.equal(requestUser(r)?.id, "dev");
  }
});

test("without auth configured, another machine on the LAN has no user", async () => {
  const { auth, users } = devAuth();
  const r = req("192.168.1.40");
  assert.equal(await auth.authenticate(r), undefined);
  assert.equal(requestUser(r), undefined);
  assert.equal(users.list().length, 0, "no dev user created for it");
});

test("a request from this machine addressed to another host (a local reverse proxy, DNS rebinding) is no dev user", async () => {
  const { auth } = devAuth();
  for (const host of ["friday.thewhite.nl", "evil.example:8080", "localhost.evil.example"]) assert.equal(await auth.authenticate(req("127.0.0.1", { host })), undefined, host);
  assert.equal(await auth.authenticate(req("127.0.0.1", {})), undefined, "no Host header");
  for (const host of ["localhost", "127.0.0.1:8080", "[::1]:5173", "LOCALHOST:1"]) assert.equal((await auth.authenticate(req("::1", { host })))?.user.id, "dev", host);
});

test("a forged forwarding header does not make a LAN request local", async () => {
  const { auth } = devAuth();
  assert.equal(await auth.authenticate(req("192.168.1.40", { host: "localhost", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" })), undefined);
});

test("cookies: the session cookie name follows the public URL's scheme; values round-trip", () => {
  assert.equal(sessionCookieName("https://friday.thewhite.nl"), "__Host-friday_session");
  assert.equal(sessionCookieName("http://localhost:5173"), "friday_session");
  assert.equal(sessionCookieName(undefined), "friday_session");
  const set = serializeCookie("__Host-friday_session", "abc+/=", { publicUrl: "https://friday.thewhite.nl", maxAge: 60 });
  assert.equal(set, "__Host-friday_session=abc%2B%2F%3D; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60");
  assert.ok(!serializeCookie("friday_session", "x", { publicUrl: "http://localhost" }).includes("Secure"));
  assert.equal(readCookie("a=1; __Host-friday_session=abc%2B%2F%3D; b=2", "__Host-friday_session"), "abc+/=");
  assert.equal(readCookie("friday_session_x=1", "friday_session"), undefined);
  assert.equal(readCookie("friday_session=%E0%A4%A", "friday_session"), undefined);
  assert.equal(readCookie(undefined, "friday_session"), undefined);
});
