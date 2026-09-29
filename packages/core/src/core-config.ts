/**
 * Core's own configuration, declared like a module's so it is listed and edited in the portal
 * (Settings > Configuration, requested by `core`) and resolved the same way: core scope, then
 * global, then the environment, read at each use. FRIDAY_MASTER_KEY stays environment-only
 * because it encrypts the store.
 */
import { DEFAULT_TIME_ZONE, type ConfigResolver, type Env, type ModuleManifest } from "@friday/sdk";
import type { Scheduler } from "./jobs/scheduler.js";
import type { ConfigStore } from "./secrets/config-store.js";
import { createResolver } from "./secrets/resolver.js";

export const CORE_ID = "core";

export const coreManifest: ModuleManifest = {
  id: CORE_ID,
  label: "Core",
  config: [
    { key: "GEMINI_API_KEY", secret: true, required: true, description: "Gemini API key for voice sessions and text generation" },
    { key: "FRIDAY_TIMEZONE", description: `IANA zone for cron job schedules (default ${DEFAULT_TIME_ZONE})` },
  ],
};

/** Live resolver for core's keys. */
export const coreConfig = (store: ConfigStore | undefined, env: Env): ConfigResolver => createResolver(store, env)(CORE_ID);

/**
 * `AppDeps.onConfigChange` for the scheduler: a saved or cleared FRIDAY_TIMEZONE, in any scope, makes cron
 * resolve the zone again (it re-plans only when the zone in effect changed).
 */
export const followTimezone = (jobs: Pick<Scheduler, "refreshTimezone">) => (_scope: string, key: string): void => {
  if (key === "FRIDAY_TIMEZONE") jobs.refreshTimezone();
};
