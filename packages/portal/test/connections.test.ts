import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankDraft, canSave, draftOf, isDirty, isGeneric, providerIdOf, redirectUriOf, saveBody, scopesOf, scopesSummary, statusOf, toneOf, type Connection,
} from "../src/lib/connections.ts";

const conn = (over: Partial<Connection> = {}): Connection => ({
  provider: "spotify",
  name: "Spotify",
  configured: true,
  generic: false,
  clientId: "client-1",
  hasClientSecret: true,
  extraScopes: [],
  requestedScopes: ["playlist-read-private"],
  missingScopes: [],
  requesters: [],
  state: "connected",
  redirectUri: "https://friday.example/api/oauth/spotify/callback",
  ...over,
});
const acme = conn({ provider: "acme", name: "acme", generic: true, authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token", extraScopes: ["read", "write"] });

test("a stored connection fills the form without its client secret; a new one starts blank", () => {
  assert.deepEqual(draftOf(conn()), { provider: "spotify", genericId: "", clientId: "client-1", clientSecret: "", authUrl: "", tokenUrl: "", extraScopes: "" });
  assert.deepEqual(draftOf(acme), { provider: "generic", genericId: "acme", clientId: "client-1", clientSecret: "", authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token", extraScopes: "read write" });
  assert.deepEqual(draftOf(null), blankDraft());
});

test("the provider id is the entry's, the chosen catalogue provider, or the typed generic id", () => {
  assert.equal(providerIdOf(conn(), blankDraft()), "spotify");
  assert.equal(providerIdOf(null, { ...blankDraft(), provider: "github" }), "github");
  assert.equal(providerIdOf(null, { ...blankDraft(), provider: "generic", genericId: "  acme " }), "acme");
  assert.equal(isGeneric(null, { ...blankDraft(), provider: "generic" }), true);
  assert.equal(isGeneric(acme, blankDraft()), true, "a stored entry decides, not the form");
  assert.equal(isGeneric(conn(), { ...blankDraft(), provider: "generic" }), false);
});

test("the redirect URI needs a provider id and encodes it", () => {
  assert.equal(redirectUriOf("https://friday.example", ""), "");
  assert.equal(redirectUriOf("https://friday.example", "acme corp"), "https://friday.example/api/oauth/acme%20corp/callback");
});

test("an unchanged stored secret is not sent; a typed one is", () => {
  const d = draftOf(conn());
  assert.deepEqual(saveBody(d, false), { clientId: "client-1", extraScopes: [] });
  assert.deepEqual(saveBody({ ...d, clientSecret: "s3cret", clientId: " client-2 " }, false), { clientId: "client-2", clientSecret: "s3cret", extraScopes: [] });
});

test("a generic provider sends its endpoints, a catalogue one never does", () => {
  const d = { ...draftOf(acme), authUrl: " https://acme.example/auth ", extraScopes: "read, write\nadmin" };
  assert.deepEqual(saveBody(d, true), { clientId: "client-1", extraScopes: ["read", "write", "admin"], authUrl: "https://acme.example/auth", tokenUrl: "https://acme.example/token" });
  assert.equal("authUrl" in saveBody(d, false), false);
  assert.deepEqual(scopesOf(" a,b  c\n"), ["a", "b", "c"]);
});

test("the form is dirty when anything that would be saved changed, and always for a connection not set up", () => {
  assert.equal(isDirty(conn(), draftOf(conn())), false);
  assert.equal(isDirty(conn(), { ...draftOf(conn()), clientSecret: "x" }), true);
  assert.equal(isDirty(conn(), { ...draftOf(conn()), clientId: " client-1 " }), false, "whitespace alone is no change");
  assert.equal(isDirty(acme, { ...draftOf(acme), extraScopes: "read,write" }), false, "the same scopes typed differently");
  assert.equal(isDirty(acme, { ...draftOf(acme), tokenUrl: "https://acme.example/t2" }), true);
  assert.equal(isDirty(conn({ configured: false }), draftOf(conn())), true);
  assert.equal(isDirty(null, blankDraft()), true);
});

test("saving needs secrets, a provider, a client id, and both endpoints for a generic provider", () => {
  const d = draftOf(acme);
  assert.equal(canSave(true, "acme", d, true), true);
  assert.equal(canSave(false, "acme", d, true), false);
  assert.equal(canSave(true, "", d, true), false);
  assert.equal(canSave(true, "acme", { ...d, clientId: " " }, true), false);
  assert.equal(canSave(true, "acme", { ...d, tokenUrl: "" }, true), false);
  assert.equal(canSave(true, "spotify", { ...draftOf(conn()), tokenUrl: "" }, false), true);
});

test("status, tone and scope summary", () => {
  assert.deepEqual([statusOf(conn({ configured: false })), toneOf(conn({ configured: false }))], ["not set up", "neutral"]);
  const missing = conn({ missingScopes: [{ scope: "x", modules: ["sonos"] }] });
  assert.deepEqual([statusOf(missing), toneOf(missing), scopesSummary(missing)], ["needs reconnect", "warning", "1 missing, reconnect"]);
  assert.deepEqual([statusOf(conn({ state: "error" })), toneOf(conn({ state: "error" }))], ["error", "error"]);
  assert.deepEqual([toneOf(conn()), toneOf(conn({ state: "disconnected" }))], ["success", "warning"]);
  assert.equal(scopesSummary(conn({ grantedScopes: ["a", "b"] })), "2 granted");
  assert.equal(scopesSummary(conn()), "1 requested");
  assert.equal(scopesSummary(conn({ requestedScopes: [] })), "none");
});
