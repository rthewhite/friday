import { test } from "node:test";
import assert from "node:assert/strict";
import * as arctic from "arctic";
import { arcticClass, buildClient, CATALOGUE, GENERIC, providerListing, usesPkce, type AuthPattern } from "../src/oauth/catalogue.js";

const REDIRECT = "https://friday.example/api/oauth/x/callback";

/** Arctic providers left out on purpose: their constructors need a domain, tenant, realm or key. */
const EXCLUDED = ["AmazonCognito", "Apple", "Auth0", "Authentik", "Gitea", "GitLab", "KeyCloak", "Mastodon", "MicrosoftEntraId", "Okta", "Salesforce", "Synology"];
/** Arctic exports that are not providers. */
const NOT_PROVIDERS = ["OAuth2Client", "OAuth2Tokens", "OAuth2RequestError", "ArcticFetchError", "UnexpectedErrorResponseBodyError", "UnexpectedResponseError", "CodeChallengeMethod", "generateCodeVerifier", "generateState", "decodeIdToken"];

const AUTH_ARITY: Record<AuthPattern, number> = {
  "state-verifier-scopes": 3,
  "state-scopes": 2,
  "state-verifier": 2,
  "state-only": 1,
  "scopes-only": 1,
  "none": 0,
};

test("every catalogue entry matches the installed Arctic class", () => {
  for (const entry of CATALOGUE) {
    const Class = arcticClass(entry.className);
    assert.ok(Class, `${entry.id}: Arctic has no class ${entry.className}`);
    assert.equal(Class.length, entry.publicClient ? 2 : 3, `${entry.id}: constructor arity`);
    const proto = Class.prototype as Record<string, (...a: unknown[]) => unknown>;
    assert.equal(proto.createAuthorizationURL!.length, AUTH_ARITY[entry.auth], `${entry.id}: createAuthorizationURL arity`);
    const validateArity = usesPkce(entry.auth) || entry.validateWithScopes ? 2 : 1;
    assert.equal(proto.validateAuthorizationCode!.length, validateArity, `${entry.id}: validateAuthorizationCode arity`);
    assert.equal(typeof proto.refreshAccessToken === "function", entry.refresh, `${entry.id}: refresh support`);
    if (entry.refresh) assert.equal(proto.refreshAccessToken!.length, entry.refreshWithScopes ? 2 : 1, `${entry.id}: refreshAccessToken arity`);
  }
});

test("every catalogue entry builds an authorization URL with state, and a code challenge when it uses PKCE", () => {
  for (const entry of CATALOGUE) {
    const client = buildClient({ provider: entry.id, clientId: "id", clientSecret: "secret" }, REDIRECT);
    const verifier = client.pkce ? arctic.generateCodeVerifier() : undefined;
    const url = client.authorizationUrl("st4te", verifier, ["a", "b"]);
    assert.equal(url.protocol, "https:", entry.id);
    assert.equal(url.searchParams.get("state"), "st4te", `${entry.id}: state`);
    assert.equal(url.searchParams.has("code_challenge"), usesPkce(entry.auth), `${entry.id}: code_challenge`);
    assert.equal(client.pkce, usesPkce(entry.auth), entry.id);
  }
});

test("Arctic has no provider the catalogue neither offers nor excludes", () => {
  const known = new Set([...CATALOGUE.map((c) => c.className), ...EXCLUDED, ...NOT_PROVIDERS]);
  const unknown = Object.keys(arctic).filter((name) => !known.has(name));
  assert.deepEqual(unknown, [], "add these Arctic providers to the catalogue or to EXCLUDED");
});

test("Google asks for offline access with consent so a refresh token comes back", () => {
  const url = buildClient({ provider: "google", clientId: "id", clientSecret: "s" }, REDIRECT).authorizationUrl("s", arctic.generateCodeVerifier(), ["email"]);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
});

test("a generic client uses PKCE S256 and space-separated scopes against the connection's URLs", () => {
  const client = buildClient({ provider: "acme", clientId: "id", authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token" }, REDIRECT);
  const url = client.authorizationUrl("st4te", arctic.generateCodeVerifier(), ["read", "write"]);
  assert.equal(`${url.origin}${url.pathname}`, "https://acme.example/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "read write");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("state"), "st4te");
});

test("a catalogue client without a secret is a public client: client_id in the body, no Basic auth", async () => {
  const seen: { auth: string | null; body: URLSearchParams }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    seen.push({ auth: req.headers.get("authorization"), body: new URLSearchParams(await req.text()) });
    return new Response(JSON.stringify({ access_token: "AT", token_type: "Bearer", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const verifier = arctic.generateCodeVerifier();
    await buildClient({ provider: "spotify", clientId: "public-id" }, REDIRECT).exchange("code", verifier, []);
    await buildClient({ provider: "spotify", clientId: "id", clientSecret: "s3cret" }, REDIRECT).exchange("code", verifier, []);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen[0]!.auth, null);
  assert.equal(seen[0]!.body.get("client_id"), "public-id");
  assert.equal(seen[1]!.auth, `Basic ${Buffer.from("id:s3cret").toString("base64")}`);
});

test("a generic client without URLs cannot be built", () => {
  assert.throws(() => buildClient({ provider: "acme", clientId: "id" }, REDIRECT), /acme: a generic provider needs an authorization URL and a token URL/);
});

test("the provider listing is sorted by name and ends with generic", () => {
  const list = providerListing();
  const names = list.slice(0, -1).map((p) => p.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal(list.at(-1)!.id, GENERIC);
  assert.deepEqual(list.find((p) => p.id === "spotify"), { id: "spotify", name: "Spotify", pkce: true, refresh: true });
  assert.equal(list.length, CATALOGUE.length + 1);
});
