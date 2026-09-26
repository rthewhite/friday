import type { ConfigResolver, Env } from "@friday/sdk";
import { GLOBAL_SCOPE, type ConfigStore } from "./config-store.js";

export type ConfigStatus = "set" | "pending" | "env";

/** Module scope, then global scope, then the process environment. Reads are live. */
export function createResolver(store: ConfigStore | undefined, env: Env): (moduleId: string) => ConfigResolver {
  return (moduleId) => (key) => store?.get(moduleId, key) ?? store?.get(GLOBAL_SCOPE, key) ?? (env[key] || undefined);
}

/** Where a key's value comes from, for /api/config. */
export function statusOf(store: ConfigStore | undefined, env: Env, moduleId: string, key: string): { status: ConfigStatus; scope?: string } {
  if (store?.get(moduleId, key) !== undefined) return { status: "set", scope: moduleId };
  if (store?.get(GLOBAL_SCOPE, key) !== undefined) return { status: "set", scope: GLOBAL_SCOPE };
  if (env[key]) return { status: "env" };
  return { status: "pending" };
}
