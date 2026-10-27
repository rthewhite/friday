import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { SessionStore } from "../src/auth/sessions.js";
import { UserStore } from "../src/auth/users.js";

const quiet = { log() {} };
const DAY = 24 * 60 * 60 * 1000;

function setup(masterKey: Buffer | undefined = randomBytes(32)) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  let now = new Date("2026-10-27T10:00:00.000Z");
  const users = new UserStore(db, () => now);
  const r = users.provision({ issuer: "i", subject: "s", email: "u@x", name: "U", role: "member" });
  assert.ok(r.ok);
  const sessions = new SessionStore(db, masterKey, () => now);
  return { db, sessions, userId: r.user.id, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

test("a session stores the token's hash, not the token, and resolves to its user", () => {
  const { db, sessions, userId } = setup();
  const token = sessions.create(userId, "refresh-1");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const dump = JSON.stringify(db.prepare("SELECT token_hash, refresh_token_ct FROM sessions").all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
  assert.ok(!dump.includes(token), "token not stored");
  assert.ok(!dump.includes("refresh-1"), "refresh token sealed");
  const s = sessions.resolve(token);
  assert.equal(s?.userId, userId);
  assert.equal(s?.refreshDue, false);
  assert.equal(sessions.refreshToken(s!.id), "refresh-1");
});

test("unknown and malformed tokens resolve to nothing", () => {
  const { sessions, userId } = setup();
  sessions.create(userId);
  assert.equal(sessions.resolve(undefined), undefined);
  assert.equal(sessions.resolve(""), undefined);
  assert.equal(sessions.resolve("not a token"), undefined);
  assert.equal(sessions.resolve(randomBytes(32).toString("base64url")), undefined);
});

test("a session unused for 30 days ends; use keeps it alive", () => {
  const { sessions, userId, advance } = setup();
  const kept = sessions.create(userId);
  const idle = sessions.create(userId);
  advance(20 * DAY);
  assert.ok(sessions.resolve(kept));
  advance(11 * DAY);
  assert.ok(sessions.resolve(kept), "used 11 days ago");
  assert.equal(sessions.resolve(idle), undefined, "unused for 31 days");
  advance(-31 * DAY);
  assert.equal(sessions.resolve(idle), undefined, "ended, not just hidden");
});

test("claims are due for a refresh after 24 hours, and markRefreshed resets that and rotates the token", () => {
  const { sessions, userId, advance } = setup();
  const token = sessions.create(userId, "r1");
  advance(23 * 60 * 60 * 1000);
  assert.equal(sessions.resolve(token)?.refreshDue, false);
  advance(2 * 60 * 60 * 1000);
  const s = sessions.resolve(token)!;
  assert.equal(s.refreshDue, true);
  sessions.markRefreshed(s.id, "r2");
  assert.equal(sessions.resolve(token)?.refreshDue, false);
  assert.equal(sessions.refreshToken(s.id), "r2");
  sessions.markRefreshed(s.id);
  assert.equal(sessions.refreshToken(s.id), "r2", "kept when not rotated");
});

test("ending a user's sessions ends all of them; endToken ends one", () => {
  const { sessions, userId } = setup();
  const a = sessions.create(userId);
  const b = sessions.create(userId);
  const c = sessions.create(userId);
  sessions.endToken(c);
  assert.equal(sessions.resolve(c), undefined);
  assert.equal(sessions.endUser(userId), 2);
  assert.equal(sessions.resolve(a), undefined);
  assert.equal(sessions.resolve(b), undefined);
});

test("a refresh token sealed with another master key can't be read", () => {
  const { db, sessions, userId } = setup();
  const token = sessions.create(userId, "r1");
  const other = new SessionStore(db, randomBytes(32));
  const s = other.resolve(token)!;
  assert.equal(other.refreshToken(s.id), undefined);
  const none = new SessionStore(db, undefined);
  assert.equal(none.refreshToken(s.id), undefined);
});
