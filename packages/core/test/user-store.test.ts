import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { DEV_USER_ID, UserConflict, UserNotFound, UserStore, type LoginClaims } from "../src/auth/users.js";

const quiet = { log() {} };
const ISSUER = "https://auth.example/application/o/friday/";

function store(at = "2026-10-27T10:00:00.000Z") {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  let now = new Date(at);
  const users = new UserStore(db, () => now);
  return { db, users, advance: (iso: string) => (now = new Date(iso)) };
}

const claims = (over: Partial<LoginClaims> = {}): LoginClaims => ({
  issuer: ISSUER,
  subject: "sub-1",
  email: "sanne@example.org",
  name: "Sanne",
  role: "member",
  ...over,
});

test("first login creates the user with role, email, name and login times", () => {
  const { users } = store();
  const r = users.provision(claims());
  assert.ok(r.ok);
  assert.equal(r.created, true);
  assert.deepEqual({ ...r.user, id: "x" }, {
    id: "x",
    name: "Sanne",
    email: "sanne@example.org",
    role: "member",
    disabled: false,
    firstLoginAt: "2026-10-27T10:00:00.000Z",
    lastLoginAt: "2026-10-27T10:00:00.000Z",
  });
});

test("a known user's login updates name, email, role and last login, without a new user", () => {
  const { users, advance } = store();
  const first = users.provision(claims());
  assert.ok(first.ok);
  advance("2026-10-28T09:00:00.000Z");
  const again = users.provision(claims({ name: "Sanne V.", email: "s@example.org", role: "admin" }));
  assert.ok(again.ok);
  assert.equal(again.created, false);
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.user.name, "Sanne V.");
  assert.equal(again.user.email, "s@example.org");
  assert.equal(again.user.role, "admin");
  assert.equal(again.user.firstLoginAt, "2026-10-27T10:00:00.000Z");
  assert.equal(again.user.lastLoginAt, "2026-10-28T09:00:00.000Z");
  assert.equal(users.list().length, 1);
});

test("the display name falls back to preferred_username, then the email", () => {
  const { users } = store();
  const a = users.provision(claims({ subject: "a", email: "a@x", name: undefined, preferredUsername: "akadmin" }));
  const b = users.provision(claims({ subject: "b", email: "b@x", name: " ", preferredUsername: undefined }));
  assert.ok(a.ok && b.ok);
  assert.equal(a.user.name, "akadmin");
  assert.equal(b.user.name, "b@x");
});

test("an unknown subject with an existing user's email is refused and creates nothing", () => {
  const { users } = store();
  const first = users.provision(claims());
  assert.ok(first.ok);
  const r = users.provision(claims({ subject: "sub-2", email: "SANNE@example.org" }));
  assert.deepEqual(r, { ok: false, reason: "email_conflict", conflictingUserId: first.user.id });
  assert.equal(users.list().length, 1);
});

test("the same subject under another issuer is another user", () => {
  const { users } = store();
  users.provision(claims({ email: undefined }));
  const r = users.provision(claims({ issuer: "https://other.example/", email: undefined }));
  assert.ok(r.ok && r.created);
  assert.equal(users.list().length, 2);
});

test("the first admin becomes the owner once; a member first records none; a second admin changes nothing", () => {
  const { users } = store();
  users.provision(claims({ subject: "m", email: "m@x" }));
  assert.equal(users.ownerId(), undefined, "a member first");
  const admin = users.provision(claims({ subject: "a1", email: "a1@x", role: "admin" }));
  assert.ok(admin.ok);
  assert.equal(users.ownerId(), admin.user.id);
  users.provision(claims({ subject: "a2", email: "a2@x", role: "admin" }));
  assert.equal(users.ownerId(), admin.user.id, "second admin");
  users.provision(claims({ subject: "a1", email: "a1@x", role: "member" }));
  assert.equal(users.ownerId(), admin.user.id, "owner kept after losing the admin role");
});

test("a member promoted by a claim refresh becomes the owner when none is recorded", () => {
  const { users } = store();
  const m = users.provision(claims());
  assert.ok(m.ok);
  const u = users.refresh(m.user.id, { email: "sanne@example.org", name: "Sanne", role: "admin" });
  assert.equal(u?.role, "admin");
  assert.equal(users.ownerId(), m.user.id);
  assert.equal(users.refresh("nope", { role: "member" }), undefined);
});

test("the dev user is a fixed admin, created once, and never the owner", () => {
  const { users } = store();
  const dev = users.devUser();
  assert.deepEqual({ id: dev.id, name: dev.name, role: dev.role }, { id: DEV_USER_ID, name: "Dev", role: "admin" });
  assert.equal(users.devUser().id, DEV_USER_ID);
  assert.equal(users.list().length, 1);
  assert.equal(users.ownerId(), undefined);
});

test("an admin disables and enables a user, but not themselves or the dev user", () => {
  const { users } = store();
  const admin = users.provision(claims({ subject: "a", email: "a@x", role: "admin" }));
  const member = users.provision(claims());
  assert.ok(admin.ok && member.ok);
  assert.equal(users.setDisabled(member.user.id, true, admin.user.id).disabled, true);
  assert.equal(users.setDisabled(member.user.id, false, admin.user.id).disabled, false);
  assert.throws(() => users.setDisabled(admin.user.id, true, admin.user.id), UserConflict);
  users.devUser();
  assert.throws(() => users.setDisabled(DEV_USER_ID, true, admin.user.id), UserConflict);
  assert.throws(() => users.setDisabled("nope", true, admin.user.id), UserNotFound);
});

test("a disabled user promoted to admin does not become the owner", () => {
  const { users } = store();
  const admin = users.provision(claims({ subject: "a", email: "a@x", role: "member" }));
  const m = users.provision(claims());
  assert.ok(admin.ok && m.ok);
  users.setDisabled(m.user.id, true, admin.user.id);
  users.refresh(m.user.id, { email: "sanne@example.org", role: "admin" });
  assert.equal(users.ownerId(), undefined);
});
