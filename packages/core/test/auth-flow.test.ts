import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { OidcClient } from "../src/auth/oidc.js";
import { safeReturnTo } from "../src/auth/routes.js";
import { readCookie } from "../src/auth/cookies.js";
import { startFakeProvider } from "./oidc-fixture.js";
import { admin, member, quiet, startAuthApp } from "./auth-harness.js";

const sessionToken = (cookies: Map<string, string>) => cookies.get("friday_session");

test("the fake provider and the OIDC client complete one code exchange", async () => {
  const p = await startFakeProvider();
  try {
    const client = new OidcClient({ issuer: p.issuer, clientId: p.clientId, clientSecret: p.clientSecret, userGroup: "u", adminGroup: "a" }, () => "http://127.0.0.1:1/auth/callback");
    const start = await client.start();
    const { code } = p.authorize(start.url.toString());
    const r = await client.finish(code, start.codeVerifier, start.nonce);
    assert.deepEqual(r.claims, { issuer: p.issuer, subject: "sub-owner", email: "owner@example.org", name: "Owner", preferredUsername: undefined, groups: ["friday-admins"] });
    assert.ok(r.refreshToken);
    assert.equal(await client.endSessionUrl(), `${p.issuer}end-session/`);
  } finally {
    await p.close();
  }
});

test("login redirects to the provider with PKCE, state, nonce, the scopes and the redirect URI, in a 10-minute cookie", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    const res = await b.fetch("/auth/login?return_to=/chat/abc");
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location")!);
    const q = to.searchParams;
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("client_id"), "friday");
    assert.equal(q.get("redirect_uri"), `${app.base}/auth/callback`);
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.ok(q.get("code_challenge") && q.get("state") && q.get("nonce"));
    assert.deepEqual(q.get("scope")?.split(" "), ["openid", "email", "profile", "offline_access"]);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("friday_login="))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=600/);
  } finally {
    await app.close();
  }
});

test("login and back: a session cookie is set and the browser lands on the return path", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    const res = await b.login("/chat/abc");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/chat/abc");
    const set = res.headers.getSetCookie();
    assert.ok(set.some((c) => /^friday_login=;.*Max-Age=0/.test(c)), "login cookie cleared");
    const session = set.find((c) => c.startsWith("friday_session="))!;
    assert.match(session, /HttpOnly; SameSite=Lax/);
    assert.match(session, /Max-Age=2592000/);
    assert.ok(!/Secure/.test(session), "plain http: no Secure");
    const s = app.sessions.resolve(sessionToken(b.cookies));
    assert.equal(app.users.get(s!.userId)?.name, "Owner");
  } finally {
    await app.close();
  }
});

test("on https the session cookie is __Host- and Secure", async () => {
  const app = await startAuthApp({ publicUrl: "https://friday.example" });
  try {
    const b = app.browser();
    const start = await b.fetch("/auth/login");
    assert.ok(start.headers.getSetCookie().some((c) => c.startsWith("__Host-friday_login=") && /; Secure/.test(c)));
    const { code, state } = app.provider.authorize(start.headers.get("location")!);
    const res = await b.fetch(`/auth/callback?code=${code}&state=${state}`);
    assert.equal(res.status, 302);
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("__Host-friday_session=") && /Path=\/; HttpOnly; SameSite=Lax; Secure/.test(c)));
  } finally {
    await app.close();
  }
});

test("return paths that leave Friday are replaced by /", async () => {
  for (const bad of ["//evil.example/", "/\\evil.example", "/\t/evil.example", "https://evil.example/", "evil", "", null]) assert.equal(safeReturnTo(bad), "/", String(bad));
  for (const good of ["/", "/chat/abc", "/settings/users?x=1#y", "/m/brain"]) assert.equal(safeReturnTo(good), good);
  const app = await startAuthApp();
  try {
    const res = await app.browser().login("//evil.example/");
    assert.equal(res.headers.get("location"), "/");
  } finally {
    await app.close();
  }
});

test("a callback whose state doesn't match the login cookie shows an error page and starts no session", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    const start = await b.fetch("/auth/login");
    const { code } = app.provider.authorize(start.headers.get("location")!);
    const res = await b.fetch(`/auth/callback?code=${code}&state=forged`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Login failed/);
    assert.equal(sessionToken(b.cookies), undefined);
    assert.equal(b.cookies.get("friday_login"), undefined, "login cookie cleared");
    // without any login cookie
    const other = await app.browser().fetch(`/auth/callback?code=x&state=y`);
    assert.equal(other.status, 400);
  } finally {
    await app.close();
  }
});

test("an ID token with the wrong nonce, issuer, audience or expiry is refused", async () => {
  const app = await startAuthApp();
  try {
    for (const override of [{ nonce: "other" }, { iss: "https://evil.example/" }, { aud: "someone-else" }, { exp: Math.floor(Date.now() / 1000) - 3600 }]) {
      app.provider.idTokenOverride = override;
      const b = app.browser();
      const res = await b.login();
      assert.equal(res.status, 400, JSON.stringify(override));
      assert.equal(sessionToken(b.cookies), undefined);
    }
    assert.equal(app.users.list().length, 0);
  } finally {
    await app.close();
  }
});

test("a provider error such as access_denied is shown", async () => {
  const app = await startAuthApp();
  try {
    const res = await app.browser().fetch("/auth/callback?error=access_denied&error_description=%3Cb%3Eno%3C/b%3E");
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /access_denied/);
    assert.match(html, /&lt;b&gt;no&lt;\/b&gt;/, "escaped");
  } finally {
    await app.close();
  }
});

test("a person outside Friday's groups gets the no-access page, no session and no user", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    const res = await b.login("/", { sub: "sub-guest", email: "guest@example.org", name: "Guest", groups: ["family"] });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /No access to Friday/);
    assert.ok(html.includes(`${app.provider.issuer}end-session/`), "links to log out at the provider");
    assert.equal(sessionToken(b.cookies), undefined);
    assert.equal(app.users.list().length, 0);
    assert.ok(app.logs.some((l) => l.includes("sub-guest") && l.includes("family")), "subject and groups logged");
    const none = await app.browser().login("/", { sub: "sub-x", email: "x@example.org" });
    assert.equal(none.status, 403, "no groups claim at all");
  } finally {
    await app.close();
  }
});

test("a member logs in as member; the first admin becomes the owner", async () => {
  const app = await startAuthApp();
  try {
    assert.equal((await app.browser().login("/", member)).status, 302);
    assert.equal(app.users.ownerId(), undefined);
    assert.equal((await app.browser().login("/", admin)).status, 302);
    const owner = app.users.list().find((u) => u.name === "Owner")!;
    assert.equal(owner.role, "admin");
    assert.equal(app.users.ownerId(), owner.id);
    assert.equal(app.users.list().find((u) => u.name === "Sanne")?.role, "member");
  } finally {
    await app.close();
  }
});

test("groups missing from the ID token are read from userinfo", async () => {
  const app = await startAuthApp({ person: member });
  try {
    app.provider.groupsOnlyInUserinfo = true;
    assert.equal((await app.browser().login()).status, 302);
    assert.equal(app.users.list()[0]?.role, "member");
  } finally {
    await app.close();
  }
});

test("a new subject with an existing user's email is refused and logged with both subjects", async () => {
  const app = await startAuthApp();
  try {
    await app.browser().login("/", admin);
    const b = app.browser();
    const res = await b.login("/", { ...admin, sub: "sub-new" });
    assert.equal(res.status, 403);
    assert.equal(app.users.list().length, 1);
    assert.equal(sessionToken(b.cookies), undefined);
    assert.ok(app.logs.some((l) => l.includes("sub-new") && l.includes("sub-owner")));
  } finally {
    await app.close();
  }
});

test("a disabled user's login is refused", async () => {
  const app = await startAuthApp();
  try {
    await app.browser().login("/", admin);
    await app.browser().login("/", member);
    const owner = app.users.list().find((u) => u.name === "Owner")!;
    const sanne = app.users.list().find((u) => u.name === "Sanne")!;
    app.users.setDisabled(sanne.id, true, owner.id);
    const b = app.browser();
    const res = await b.login("/", member);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /disabled/);
    assert.equal(sessionToken(b.cookies), undefined);
  } finally {
    await app.close();
  }
});

test("logout ends the session, clears the cookie and returns the provider's end-session URL", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    await b.login();
    const token = sessionToken(b.cookies)!;
    const res = await b.fetch("/auth/logout", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { endSessionUrl: `${app.provider.issuer}end-session/` });
    assert.equal(sessionToken(b.cookies), undefined, "cookie cleared");
    assert.equal(app.sessions.resolve(token), undefined, "session ended");
    // also without a session
    assert.equal((await app.browser().fetch("/auth/logout", { method: "POST" })).status, 200);
  } finally {
    await app.close();
  }
});

test("a cross-site logout is refused and the session is kept", async () => {
  const app = await startAuthApp();
  try {
    const b = app.browser();
    await b.login();
    const token = sessionToken(b.cookies)!;
    const res = await b.fetch("/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.ok(app.sessions.resolve(token));
  } finally {
    await app.close();
  }
});

test("without OIDC configured, /auth paths answer 404 and never the portal", async () => {
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  const { McpServerStore } = await import("../src/tools/mcp-store.js");
  const { DatabaseSync } = await import("node:sqlite");
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, new McpServerStore(new DatabaseSync(":memory:"), undefined), { log: quiet }), webDir: "/nonexistent" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const p of ["/auth/login", "/auth/callback", "/auth/nope"]) assert.equal((await fetch(base + p, { redirect: "manual" })).status, 404, p);
    assert.equal((await fetch(base + "/auth/logout", { method: "POST" })).status, 404);
  } finally {
    server.close();
  }
  assert.equal(readCookie("a=b", "a"), "b");
});

test("a userinfo outage during login shows the login error page, not a bare 500", async () => {
  const app = await startAuthApp();
  try {
    app.provider.groupsOnlyInUserinfo = true;
    app.provider.userinfoDown = true;
    const b = app.browser();
    const res = await b.login();
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Login failed/);
    assert.match(html, /can&#39;t be reached/);
    assert.equal(b.cookies.get("friday_session"), undefined);
  } finally {
    await app.close();
  }
});
