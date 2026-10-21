import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModuleManifest } from "@friday/sdk";
import { OAuthRequests } from "../src/oauth/requests.js";

const spotifyModule: ModuleManifest = { id: "spotify", label: "Spotify", oauth: [{ provider: "spotify", scopes: ["playlist-read-private", "playlist-read-collaborative"], description: "Read your playlists" }] };
const sonos: ModuleManifest = { id: "sonos", label: "Sonos", oauth: [{ provider: "spotify", scopes: ["user-modify-playback-state", "playlist-read-private"] }] };
const acme: ModuleManifest = { id: "acme-sync", label: "Acme", oauth: [{ provider: "acme", scopes: ["read"], authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token" }] };
const broken = { id: "broken", label: "Broken", oauth: [{ provider: "spotify", scopes: ["x"], authUrl: "https://a.example/a" }] } as ModuleManifest;

test("requests are listed per provider in load order, skipping malformed manifests", () => {
  const r = new OAuthRequests(() => [spotifyModule, broken, sonos, { id: "travel", label: "Travel" }, acme]);
  const by = r.byProvider();
  assert.deepEqual([...by.keys()], ["spotify", "acme"]);
  assert.deepEqual(by.get("spotify")!.map((x) => x.module), ["spotify", "sonos"]);
  assert.deepEqual(r.forModule("spotify", "spotify"), { module: "spotify", scopes: ["playlist-read-private", "playlist-read-collaborative"], description: "Read your playlists" });
  assert.equal(r.forModule("spotify", "travel"), undefined);
});

test("the scopes to ask for are the granted modules' plus extras, without duplicates", () => {
  const r = new OAuthRequests(() => [spotifyModule, sonos]);
  assert.deepEqual(r.requestedScopes("spotify", ["spotify"], ["user-read-email"]), ["playlist-read-private", "playlist-read-collaborative", "user-read-email"]);
  assert.deepEqual(r.requestedScopes("spotify", ["spotify", "sonos"], ["playlist-read-private"]), ["playlist-read-private", "playlist-read-collaborative", "user-modify-playback-state"]);
});

test("an ungranted module does not widen the login", () => {
  const r = new OAuthRequests(() => [spotifyModule, sonos]);
  assert.ok(!r.requestedScopes("spotify", ["spotify"], []).includes("user-modify-playback-state"));
  assert.deepEqual(r.requestedScopes("spotify", [], []), []);
});

test("a grant that needs a new scope lists it as missing for that module", () => {
  const r = new OAuthRequests(() => [spotifyModule, sonos]);
  const granted = ["playlist-read-private", "playlist-read-collaborative"];
  assert.deepEqual(r.missingScopes("spotify", ["spotify"], [], granted), []);
  assert.deepEqual(r.missingScopes("spotify", ["spotify", "sonos"], ["user-read-email"], granted), [
    { scope: "user-modify-playback-state", modules: ["sonos"] },
    { scope: "user-read-email", modules: [] },
  ]);
});

test("a provider that granted less shows the rest as missing; nothing is missing before the first login", () => {
  const r = new OAuthRequests(() => [spotifyModule]);
  assert.deepEqual(r.missingScopes("spotify", ["spotify"], [], ["playlist-read-private"]), [{ scope: "playlist-read-collaborative", modules: ["spotify"] }]);
  assert.deepEqual(r.missingScopes("spotify", ["spotify"], [], undefined), []);
});

test("a module that left the list no longer requests anything", () => {
  let list: ModuleManifest[] = [spotifyModule, acme];
  const r = new OAuthRequests(() => list);
  assert.equal(r.of("acme").length, 1);
  list = [spotifyModule];
  assert.deepEqual(r.of("acme"), []);
  assert.equal(r.byProvider().has("acme"), false);
});

test("generic URL defaults come from the first request that carries them", () => {
  const r = new OAuthRequests(() => [{ id: "other", label: "Other", oauth: [{ provider: "acme", scopes: [] }] }, acme]);
  assert.deepEqual(r.genericDefaults("acme"), { authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token" });
  assert.equal(r.genericDefaults("spotify"), undefined);
});
