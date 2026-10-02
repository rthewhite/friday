import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceDisplay, deviceLabels } from "../src/lib/devices.ts";

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
