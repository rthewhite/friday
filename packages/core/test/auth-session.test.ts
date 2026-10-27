import { test } from "node:test";
import assert from "node:assert/strict";
import { admin, member, startAuthApp, type AuthApp } from "./auth-harness.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function me(app: AuthApp, b: ReturnType<AuthApp["browser"]>) {
  const res = await b.fetch("/api/me");
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { name: string; role: string }) : undefined };
}

test("a session is used until it has been idle for 30 days", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const b = app.browser();
    await b.login();
    assert.equal((await me(app, b)).status, 200);
    app.advance(20 * HOUR);
    assert.equal((await me(app, b)).status, 200);
    app.advance(31 * DAY);
    assert.equal((await me(app, b)).status, 401);
  } finally {
    await app.close();
  }
});

test("claims refreshed after a day promote a member to admin", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const b = app.browser();
    await b.login();
    assert.equal((await b.fetch("/api/config")).status, 403);
    app.provider.person = { ...member, groups: ["friday-admins"], name: "Sanne V." };
    app.advance(23 * HOUR);
    assert.equal((await me(app, b)).body?.role, "member", "not refreshed within a day");
    assert.equal(app.provider.calls.refresh_token, 0);
    app.advance(2 * HOUR);
    const after = await me(app, b);
    assert.deepEqual(after.body && { role: after.body.role, name: after.body.name }, { role: "admin", name: "Sanne V." });
    assert.equal(app.provider.calls.refresh_token, 1);
    assert.notEqual((await b.fetch("/api/config")).status, 403);
    assert.equal(app.provider.calls.refresh_token, 1, "the next refresh is a day later");
  } finally {
    await app.close();
  }
});

test("an admin removed from the admin group is a member after the refresh", async () => {
  const app = await startAuthApp({ person: admin });
  try {
    const b = app.browser();
    await b.login();
    app.provider.person = { ...admin, groups: ["friday-users"] };
    app.advance(25 * HOUR);
    assert.equal((await me(app, b)).body?.role, "member");
    assert.equal((await b.fetch("/api/users")).status, 403);
  } finally {
    await app.close();
  }
});

test("the session ends when the provider refuses the refresh, or the user lost every Friday group", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const refused = app.browser();
    await refused.login();
    const removed = app.browser();
    await removed.login();
    app.advance(25 * HOUR);
    app.provider.refuseRefresh = true;
    assert.equal((await me(app, refused)).status, 401);
    assert.ok(app.logs.some((l) => /provider refused the refresh/.test(l)));
    app.provider.refuseRefresh = false;
    app.provider.person = { ...member, groups: ["family"] };
    assert.equal((await me(app, removed)).status, 401);
    assert.ok(app.logs.some((l) => /no longer in a Friday group/.test(l)));
    app.provider.person = member;
    assert.equal((await me(app, removed)).status, 401, "ended, not just refused once");
  } finally {
    await app.close();
  }
});

test("refreshed claims about another subject end the session", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const b = app.browser();
    await b.login();
    app.provider.person = { ...member, sub: "someone-else" };
    app.advance(25 * HOUR);
    assert.equal((await me(app, b)).status, 401);
  } finally {
    await app.close();
  }
});

test("when the provider is down the session is kept and the refresh is tried again later", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const b = app.browser();
    await b.login();
    app.advance(25 * HOUR);
    app.provider.down = true;
    assert.equal((await me(app, b)).status, 200);
    assert.ok(app.logs.some((l) => /could not refresh the claims .* keeping the session/.test(l)));
    app.provider.down = false;
    app.provider.person = { ...member, name: "Sanne V." };
    assert.equal((await me(app, b)).body?.name, "Sanne V.", "retried on the next request");
  } finally {
    await app.close();
  }
});

test("without a refresh token the session ends once its claims are due", async () => {
  const app = await startAuthApp({ person: member });
  try {
    app.provider.noRefreshToken = true;
    const b = app.browser();
    await b.login();
    assert.equal((await me(app, b)).status, 200);
    app.advance(25 * HOUR);
    assert.equal((await me(app, b)).status, 401);
  } finally {
    await app.close();
  }
});

test("a disabled user's session no longer works, and an unknown or tampered cookie is no session", async () => {
  const app = await startAuthApp();
  try {
    const owner = app.browser();
    await owner.login("/", admin);
    const sanne = app.browser();
    await sanne.login("/", member);
    const sanneId = app.users.list().find((u) => u.name === "Sanne")!.id;
    app.users.setDisabled(sanneId, true, app.users.ownerId()!);
    assert.equal((await me(app, sanne)).status, 401);
    const forged = app.browser();
    forged.cookies.set("friday_session", "A".repeat(43));
    assert.equal((await me(app, forged)).status, 401);
    forged.cookies.set("friday_session", "not-a-token");
    assert.equal((await me(app, forged)).status, 401);
  } finally {
    await app.close();
  }
});

test("requests arriving together refresh the claims once, so a rotated refresh token is not reused", async () => {
  const app = await startAuthApp({ person: member });
  try {
    const b = app.browser();
    await b.login();
    app.advance(25 * HOUR);
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => me(app, b)));
    assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.equal(app.provider.calls.refresh_token, 1);
  } finally {
    await app.close();
  }
});
