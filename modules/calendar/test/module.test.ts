import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createCalendarModule } from "../src/index.js";

test("the module fails without ICLOUD_APP_PASSWORD, naming it", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_USERNAME: "me@icloud.com" } }), /ICLOUD_APP_PASSWORD/);
});

test("the module fails without ICLOUD_USERNAME, naming it", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop" } }), /ICLOUD_USERNAME/);
});
