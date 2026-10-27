import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthConfigError, authMode, isLocalPublicUrl, isLoopback, loginRedirectUri } from "../src/auth/config.js";

const full = {
  FRIDAY_AUTH_ISSUER: "https://auth.thewhite.nl/application/o/friday/",
  FRIDAY_AUTH_CLIENT_ID: "friday",
  FRIDAY_AUTH_CLIENT_SECRET: "s3cret",
};

test("complete configuration enables OIDC with the default groups", () => {
  const mode = authMode(full, "https://friday.thewhite.nl", true);
  assert.deepEqual(mode, {
    kind: "oidc",
    oidc: { issuer: full.FRIDAY_AUTH_ISSUER, clientId: "friday", clientSecret: "s3cret", userGroup: "friday-users", adminGroup: "friday-admins" },
  });
  assert.equal(loginRedirectUri("https://friday.thewhite.nl"), "https://friday.thewhite.nl/auth/callback");
  assert.equal(loginRedirectUri("https://friday.thewhite.nl/"), "https://friday.thewhite.nl/auth/callback");
});

test("the group names can be configured", () => {
  const mode = authMode({ ...full, FRIDAY_AUTH_USER_GROUP: "family", FRIDAY_AUTH_ADMIN_GROUP: "parents" }, "https://friday.thewhite.nl", true);
  assert.equal(mode.kind, "oidc");
  assert.equal(mode.kind === "oidc" && mode.oidc.userGroup, "family");
  assert.equal(mode.kind === "oidc" && mode.oidc.adminGroup, "parents");
});

test("a missing client id or secret, master key or public URL stops startup, naming the key", () => {
  assert.throws(() => authMode({ ...full, FRIDAY_AUTH_CLIENT_SECRET: "" }, "https://friday.thewhite.nl", true), (e: Error) => e instanceof AuthConfigError && /FRIDAY_AUTH_CLIENT_SECRET/.test(e.message));
  assert.throws(() => authMode({ ...full, FRIDAY_AUTH_CLIENT_ID: undefined }, "https://friday.thewhite.nl", true), /FRIDAY_AUTH_CLIENT_ID/);
  assert.throws(() => authMode(full, "https://friday.thewhite.nl", false), /FRIDAY_MASTER_KEY/);
  assert.throws(() => authMode(full, undefined, true), /FRIDAY_PUBLIC_URL/);
  assert.throws(() => authMode({ ...full, FRIDAY_AUTH_ISSUER: "not a url" }, "https://friday.thewhite.nl", true), /not a URL/);
});

test("without an issuer it runs in dev mode on localhost, and refuses a deployed public URL", () => {
  assert.deepEqual(authMode({}, undefined, false), { kind: "dev" });
  assert.deepEqual(authMode({}, "http://localhost:5173", false), { kind: "dev" });
  assert.deepEqual(authMode({}, "http://127.0.0.1:8080/friday", false), { kind: "dev" });
  assert.throws(() => authMode({}, "https://friday.thewhite.nl", true), (e: Error) => e instanceof AuthConfigError && /authentication must be configured/.test(e.message));
  assert.throws(() => authMode({}, "https://localhost", true), /authentication must be configured/);
});

test("localhost public URLs are plain http on localhost or 127.0.0.1 only", () => {
  assert.ok(isLocalPublicUrl("http://localhost"));
  assert.ok(isLocalPublicUrl("http://127.0.0.1:8081/x"));
  assert.ok(!isLocalPublicUrl("http://localhost.evil.example"));
  assert.ok(!isLocalPublicUrl("http://192.168.1.81"));
  assert.ok(!isLocalPublicUrl("nonsense"));
});

test("loopback peers are 127.0.0.0/8, ::1 and mapped loopback, nothing else", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) assert.ok(isLoopback(a), a);
  for (const a of [undefined, "", "192.168.1.40", "::ffff:192.168.1.40", "10.0.0.1", "fe80::1", "128.0.0.1", "127.0.0.1.evil"]) assert.ok(!isLoopback(a), String(a));
});
