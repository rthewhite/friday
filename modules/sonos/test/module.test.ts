import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createSonosModule } from "../src/index.js";

test("the module fails naming the Home Assistant keys when they are unset", async () => {
  await assert.rejects(createTestHost(createSonosModule()), /module sonos: missing required config HA_URL, HA_TOKEN/);
});

test("the module fails naming HA_TOKEN when only the URL is set", async () => {
  await assert.rejects(createTestHost(createSonosModule(), { env: { HA_URL: "http://ha.local" } }), /module sonos: missing required config HA_TOKEN$/);
});
