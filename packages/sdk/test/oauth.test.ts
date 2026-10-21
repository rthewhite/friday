import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthError, validateManifest, type ModuleManifest, type OAuthRequest } from "../src/index.js";

const manifest = (oauth: unknown): ModuleManifest => ({ id: "music", label: "Music", oauth: oauth as OAuthRequest[] });

test("a valid oauth request passes", () => {
  validateManifest(manifest([{ provider: "spotify", scopes: ["playlist-read-private"], description: "Read your playlists" }]));
  validateManifest(manifest([{ provider: "spotify", scopes: [] }]));
  validateManifest(manifest([{ provider: "acme", scopes: ["read"], authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token" }]));
  validateManifest(manifest(undefined));
});

test("an authUrl without a tokenUrl fails, naming the module and the provider", () => {
  assert.throws(
    () => validateManifest(manifest([{ provider: "acme", scopes: [], authUrl: "https://acme.example/authorize" }])),
    /^Error: module music: oauth request for acme: authUrl and tokenUrl go together$/,
  );
});

test("an http URL fails", () => {
  assert.throws(
    () => validateManifest(manifest([{ provider: "acme", scopes: [], authUrl: "http://acme.example/authorize", tokenUrl: "https://acme.example/token" }])),
    /module music: oauth request for acme: authUrl and tokenUrl must be https URLs/,
  );
});

test("a provider requested twice fails", () => {
  assert.throws(
    () => validateManifest(manifest([{ provider: "spotify", scopes: [] }, { provider: "spotify", scopes: ["x"] }])),
    /module music: oauth request for spotify is declared twice/,
  );
});

test("a provider id that is not kebab-case fails", () => {
  assert.throws(() => validateManifest(manifest([{ provider: "Acme", scopes: [] }])), /module music: invalid oauth provider "Acme"/);
});

test("scopes must be a list of strings", () => {
  assert.throws(() => validateManifest(manifest([{ provider: "spotify" }])), /module music: oauth request for spotify: scopes must be a list of strings/);
  assert.throws(() => validateManifest(manifest([{ provider: "spotify", scopes: [""] }])), /scopes must be a list of strings/);
  assert.throws(() => validateManifest(manifest({ provider: "spotify" })), /module music: oauth must be a list/);
});

test("OAuthError carries its kind", () => {
  const e = new OAuthError("not_granted", "grant it");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "OAuthError");
  assert.equal(e.kind, "not_granted");
  assert.equal(e.message, "grant it");
});
