#!/usr/bin/env node
/**
 * Start the sim racing module and keep it connected to Friday.
 *   FRIDAY_URL=wss://friday.example/ws/modules FRIDAY_MODULE_KEY=... node dist/bin.js
 */
import { runRemote } from "@friday/sdk/remote";
import { createSimracingModule } from "./module.js";
import { MockTelemetrySource } from "./telemetry.js";

const url = process.env.FRIDAY_URL;
const key = process.env.FRIDAY_MODULE_KEY;
if (!url || !key) {
  console.error("set FRIDAY_URL (ws[s]://host/ws/modules) and FRIDAY_MODULE_KEY");
  process.exit(2);
}

const handle = runRemote(createSimracingModule(new MockTelemetrySource()), { url, key });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void handle.stop().finally(() => process.exit(0)));
