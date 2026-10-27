import { test } from "node:test";
import assert from "node:assert/strict";
import { admin, member, startAuthApp } from "./auth-harness.js";

test("/api/me tells who I am, my role, whether I'm the owner, and that auth is on", async () => {
  const app = await startAuthApp();
  try {
    const owner = app.browser();
    await owner.login("/", admin);
    const sanne = app.browser();
    await sanne.login("/", member);
    const mine = (await (await sanne.fetch("/api/me")).json()) as Record<string, unknown>;
    assert.deepEqual({ ...mine, id: "x" }, { id: "x", name: "Sanne", email: "sanne@example.org", role: "member", owner: false, authEnabled: true });
    const theirs = (await (await owner.fetch("/api/me")).json()) as Record<string, unknown>;
    assert.equal(theirs.owner, true);
  } finally {
    await app.close();
  }
});

test("an admin lists users with role, owner, disabled and login times, and nothing secret", async () => {
  const app = await startAuthApp();
  try {
    const owner = app.browser();
    await owner.login("/", admin);
    await app.browser().login("/", member);
    const res = await owner.fetch("/api/users");
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const secret of ["sub-owner", "sub-sanne", ...owner.cookies.values()]) assert.ok(!text.includes(secret), `leaks ${secret}`);
    const { users } = JSON.parse(text) as { users: Record<string, unknown>[] };
    assert.deepEqual(users.map((u) => [u.name, u.role, u.owner, u.disabled]), [["Owner", "admin", true, false], ["Sanne", "member", false, false]]);
    assert.ok(users.every((u) => typeof u.firstLoginAt === "string" && typeof u.lastLoginAt === "string" && "email" in u));
  } finally {
    await app.close();
  }
});

test("disabling a member ends all their sessions at once and refuses their next login; enabling lets them back", async () => {
  const app = await startAuthApp();
  try {
    const owner = app.browser();
    await owner.login("/", admin);
    const phone = app.browser();
    await phone.login("/", member);
    const laptop = app.browser();
    await laptop.login("/", member);
    const id = app.users.list().find((u) => u.name === "Sanne")!.id;
    const res = await owner.fetch(`/api/users/${id}/disable`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { disabled: boolean }).disabled, true);
    assert.equal((await phone.fetch("/api/me")).status, 401);
    assert.equal((await laptop.fetch("/api/me")).status, 401);
    assert.equal((await app.browser().login("/", member)).status, 403);
    assert.ok(app.logs.some((l) => /disabled Sanne .*2 session\(s\) ended/.test(l)));
    const enabled = await owner.fetch(`/api/users/${id}/enable`, { method: "POST" });
    assert.equal(((await enabled.json()) as { disabled: boolean }).disabled, false);
    assert.equal((await app.browser().login("/", member)).status, 302);
  } finally {
    await app.close();
  }
});

test("an admin can't disable themselves; unknown users are 404; members can't disable anyone", async () => {
  const app = await startAuthApp();
  try {
    const owner = app.browser();
    await owner.login("/", admin);
    const sanne = app.browser();
    await sanne.login("/", member);
    const ownerId = app.users.ownerId()!;
    const self = await owner.fetch(`/api/users/${ownerId}/disable`, { method: "POST" });
    assert.equal(self.status, 409);
    assert.equal(app.users.get(ownerId)?.disabled, false);
    assert.equal((await owner.fetch(`/api/users/nope/disable`, { method: "POST" })).status, 404);
    assert.equal((await sanne.fetch(`/api/users/${ownerId}/disable`, { method: "POST" })).status, 403);
  } finally {
    await app.close();
  }
});
