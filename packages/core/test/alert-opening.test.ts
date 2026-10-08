import { test } from "node:test";
import assert from "node:assert/strict";
import { alertTone, TONE_PEAK } from "../src/alerts/tone.js";
import { openingText, spokenDuration } from "../src/alerts/opening.js";
import type { Alert } from "../src/alerts/store.js";

const zone = "Europe/Amsterdam";

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: "k3f9",
    kind: "timer",
    label: "eggs",
    language: "nl",
    createdAt: "2026-10-08T10:00:00.000Z", // 12:00 in Amsterdam
    dueAt: "2026-10-08T10:05:00.000Z",
    nextRingAt: "2026-10-08T10:05:00.000Z",
    target: { kind: "device", id: "friday-kitchen" },
    state: "ringing",
    rings: 0,
    local: false,
    conversationId: null,
    finishedAt: null,
    ...over,
  };
}

test("the alert tone is about two seconds of 24 kHz s16le at −12 dBFS, starting and ending silent", () => {
  const pcm = alertTone();
  const seconds = pcm.length / 2 / 24_000;
  assert.ok(seconds > 1.8 && seconds < 2.4, `${seconds} s`);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak <= TONE_PEAK && peak > TONE_PEAK * 0.95, `peak ${peak}`);
  assert.equal(TONE_PEAK, 8231);
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(pcm.length - 2), 0);
});

test("spoken durations", () => {
  assert.equal(spokenDuration(300_000), "5 minutes");
  assert.equal(spokenDuration(90_000), "1 minute 30 seconds");
  assert.equal(spokenDuration(3_900_000), "1 hour 5 minutes");
  assert.equal(spokenDuration(45_000), "45 seconds");
  assert.equal(spokenDuration(60_000), "1 minute");
});

test("one alert on time: what, length, set and due time in the household zone, the language, the snooze hint", () => {
  assert.equal(
    openingText([alert()], new Date("2026-10-08T10:05:20Z"), zone),
    'Alert: the timer "eggs" (5 minutes, set at 12:00) went off at 12:05. Tell the user briefly, in Dutch, and wait for their answer. If they want more time, call snooze_alert.',
  );
});

test("a late alert says how long ago it went off", () => {
  assert.match(openingText([alert()], new Date("2026-10-08T10:08:10Z"), zone), /went off at 12:05, 3 minutes ago\./);
  assert.match(openingText([alert()], new Date("2026-10-08T10:06:00Z"), zone), /went off at 12:05, 1 minute ago\./);
  assert.match(openingText([alert()], new Date("2026-10-08T10:05:59Z"), zone), /went off at 12:05\./, "under a minute is on time");
});

test("several alerts are listed in one text, in the first alert's language", () => {
  const text = openingText(
    [alert({ language: "en" }), alert({ id: "z2zz", label: "pasta", createdAt: "2026-10-08T09:55:00.000Z" })],
    new Date("2026-10-08T10:05:00Z"),
    zone,
  );
  assert.equal(
    text,
    'Alerts: the timer "eggs" (5 minutes, set at 12:00) went off at 12:05; the timer "pasta" (10 minutes, set at 11:55) went off at 12:05. ' +
      "Tell the user briefly, in English, and wait for their answer. If they want more time, call snooze_alert.",
  );
});

test("an opening needs an alert", () => {
  assert.throws(() => openingText([], new Date(), zone), /at least one alert/);
});
