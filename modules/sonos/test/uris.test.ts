import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUris } from "../src/uris.js";

test("every playable kind is accepted as a URI and as a link", () => {
  for (const kind of ["track", "album", "playlist", "episode", "show"]) {
    assert.deepEqual(checkUris([`spotify:${kind}:4uLU6hMCjMI75M1A2tKUQC`]), [`spotify:${kind}:4uLU6hMCjMI75M1A2tKUQC`]);
    assert.deepEqual(checkUris([`https://open.spotify.com/${kind}/4uLU6hMCjMI75M1A2tKUQC`]), [`https://open.spotify.com/${kind}/4uLU6hMCjMI75M1A2tKUQC`]);
  }
});

test("a localized share link with a query string is accepted as given", () => {
  assert.deepEqual(checkUris([" https://open.spotify.com/intl-nl/playlist/xyz?si=123 "]), ["https://open.spotify.com/intl-nl/playlist/xyz?si=123"]);
});

test("artist URIs and links are refused with what to play instead", () => {
  for (const uri of ["spotify:artist:abc", "https://open.spotify.com/artist/abc", "https://open.spotify.com/intl-de/artist/abc", "spotify:artistTopTracks:abc"]) {
    assert.throws(() => checkUris([uri]), /is a Spotify artist, which can't be played directly\. Play the artist's tracks, an album or a playlist instead/);
  }
});

test("anything else is refused by name", () => {
  for (const uri of ["https://example.com/song.mp3", "http://open.spotify.com/track/abc", "spotify:user:abc", "https://open.spotify.com/track/", "Karma Police"]) {
    assert.throws(() => checkUris([uri]), new RegExp(`"${uri.replace(/[.?/]/g, "\\$&")}" is not a Spotify`));
  }
});

test("one bad URI among good ones fails the whole list", () => {
  assert.throws(() => checkUris(["spotify:track:a", "https://example.com/song.mp3"]), /example\.com/);
});

test("between 1 and 50 URIs", () => {
  assert.throws(() => checkUris([]), /at least one Spotify URI/);
  assert.throws(() => checkUris(undefined), /at least one Spotify URI/);
  assert.equal(checkUris(Array.from({ length: 50 }, (_, i) => `spotify:track:t${i}`)).length, 50);
  assert.throws(() => checkUris(Array.from({ length: 51 }, (_, i) => `spotify:track:t${i}`)), /At most 50 URIs/);
});
