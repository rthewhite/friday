import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceDisplay, deviceLabels, deviceStatus } from "../src/lib/devices.ts";

const labels = deviceLabels([{ id: "friday-kitchen", label: "Kitchen satellite" }]);

test("a registered device is shown by its label, with its id on hover", () => {
  assert.deepEqual(deviceDisplay(labels, "friday-kitchen"), { text: "Kitchen satellite", title: "friday-kitchen" });
});

test("a device that is not registered is shown by its id", () => {
  assert.deepEqual(deviceDisplay(labels, "friday-old"), { text: "friday-old" });
});

test("a conversation without a device shows nothing", () => {
  assert.equal(deviceDisplay(labels, null), null);
});

test("status: revoked wins, then in a session, then online; old firmware without a control connection is offline", () => {
  assert.deepEqual(deviceStatus({ revoked: true, online: true, connected: true }), { state: "revoked", tone: "error" });
  assert.deepEqual(deviceStatus({ revoked: false, online: true, connected: true }), { state: "in a session", tone: "accent" });
  assert.deepEqual(deviceStatus({ revoked: false, online: false, connected: true }), { state: "in a session", tone: "accent" });
  assert.deepEqual(deviceStatus({ revoked: false, online: true, connected: false }), { state: "online", tone: "success" });
  assert.deepEqual(deviceStatus({ revoked: false, online: false, connected: false }), { state: "offline", tone: "neutral" });
});
