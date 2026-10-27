import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFetch, isAdminPath, loadMe, LOGIN_MARK, LoginGuard, loginUrl, logout, LOOP_MS, visibleItems } from "../src/lib/auth.js";

const ORIGIN = "https://friday.example";

function guard(here = "/chat/abc?x=1") {
  const went: string[] = [];
  return { went, g: new LoginGuard({ navigate: (u) => went.push(u), here: () => here }) };
}

const respond = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

test("a 401 from the API sends the browser to the login with the current path, once", async () => {
  const { went, g } = guard();
  const f = guardFetch(respond(401), g, ORIGIN);
  const res = await f("/api/conversations");
  assert.equal(res.status, 401, "the caller still gets the response");
  await f(`${ORIGIN}/api/me`);
  assert.deepEqual(went, ["/auth/login?return_to=%2Fchat%2Fabc%3Fx%3D1"]);
  assert.equal(loginUrl("/"), "/auth/login?return_to=%2F");
});

test("other statuses and other paths or origins don't trigger the login", async () => {
  const { went, g } = guard();
  await guardFetch(respond(403), g, ORIGIN)("/api/config");
  await guardFetch(respond(200), g, ORIGIN)("/api/me");
  await guardFetch(respond(401), g, ORIGIN)("/auth/logout");
  await guardFetch(respond(401), g, ORIGIN)("https://elsewhere.example/api/x");
  await guardFetch(respond(401), g, ORIGIN)("/apiary");
  assert.deepEqual(went, []);
  await guardFetch(respond(401), g, ORIGIN)(new Request(`${ORIGIN}/api/chat`, { method: "POST" }));
  assert.equal(went.length, 1, "a Request object counts too");
});

test("while a reply streams or the Talk page is live, the login waits until the last hold is released", () => {
  const { went, g } = guard("/chat");
  const stream = g.hold();
  const talk = g.hold();
  g.unauthenticated();
  assert.deepEqual(went, []);
  stream();
  stream();
  assert.deepEqual(went, [], "released twice still counts once");
  talk();
  assert.deepEqual(went, ["/auth/login?return_to=%2Fchat"]);
});

test("holds without a 401 never navigate; after stop() nothing does", () => {
  const { went, g } = guard();
  g.hold()();
  assert.deepEqual(went, []);
  g.stop();
  g.unauthenticated();
  assert.deepEqual(went, []);
});

test("boot: a user, the login, a login that didn't stick, and an unreachable Friday", async () => {
  const s = memoryStorage();
  let t = 1_000_000;
  const me = { id: "u2", name: "Sanne", email: null, role: "member", owner: false, authEnabled: true };
  assert.deepEqual(await loadMe(respond(200, me), s, () => t), { kind: "user", me });
  assert.deepEqual(await loadMe(respond(401), s, () => t), { kind: "login" });
  assert.equal(s.m.get(LOGIN_MARK), String(t));
  t += 5_000;
  assert.deepEqual(await loadMe(respond(401), s, () => t), { kind: "loop" }, "back without a session within seconds");
  t += LOOP_MS;
  assert.deepEqual(await loadMe(respond(401), s, () => t), { kind: "login" }, "much later it is an expired session again");
  assert.deepEqual(await loadMe(respond(200, me), s, () => t), { kind: "user", me });
  assert.equal(s.m.has(LOGIN_MARK), false, "a successful boot clears the mark");
  assert.deepEqual(await loadMe(respond(503), s), { kind: "error", message: "503 " });
  assert.equal((await loadMe(async () => { throw new Error("offline"); }, s)).kind, "error");
});

test("the System group and /settings pages are for admins", () => {
  const items = [{ group: "Assistant", to: "/" }, { group: "Modules", to: "/modules" }, { group: "System", to: "/settings/config" }];
  assert.deepEqual(visibleItems(items, "admin").map((i) => i.to), ["/", "/modules", "/settings/config"]);
  assert.deepEqual(visibleItems(items, "member").map((i) => i.to), ["/", "/modules"]);
  assert.deepEqual(visibleItems(items, undefined).map((i) => i.to), ["/", "/modules"]);
  assert.ok(isAdminPath("/settings/users") && isAdminPath("/settings"));
  assert.ok(!isAdminPath("/settingsx") && !isAdminPath("/chat"));
});

test("logout posts to /auth/logout and returns the end-session URL", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const url = await logout((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init]);
    return new Response(JSON.stringify({ endSessionUrl: "https://auth.example/end" }), { status: 200 });
  }) as typeof fetch);
  assert.equal(url, "https://auth.example/end");
  assert.deepEqual(calls.map(([u, i]) => [u, i?.method]), [["/auth/logout", "POST"]]);
  assert.equal(await logout(respond(200, { endSessionUrl: null })), null);
  await assert.rejects(logout(respond(403)), /logout failed: 403/);
});
