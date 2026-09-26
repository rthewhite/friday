/**
 * Building blocks shared by every host (core's in-process host, the test host and,
 * later, the remote runner): config validation and context construction.
 */
import type { ModuleHttp } from "./http.js";
import type { ModuleConfig, ModuleContext, ModuleLogger, ModuleManifest } from "./module.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool } from "./tool.js";

export type Env = Record<string, string | undefined>;

/** Names of `required` config keys that are unset in `env`. */
export function missingConfig(manifest: ModuleManifest, env: Env): string[] {
  return (manifest.config ?? []).filter((c) => c.required && !env[c.key]).map((c) => c.key);
}

/** Throws the host's standard error when a required key is unset. */
export function assertConfig(manifest: ModuleManifest, env: Env): void {
  const missing = missingConfig(manifest, env);
  if (missing.length) throw new Error(`module ${manifest.id}: missing required config ${missing.join(", ")}`);
}

export function envConfig(manifest: ModuleManifest, env: Env): ModuleConfig {
  return {
    get: (key) => env[key] || undefined,
    require(key) {
      const v = env[key];
      if (!v) throw new Error(`${manifest.id}: ${key} is not configured`);
      return v;
    },
  };
}

export function prefixedLogger(id: string, base: ModuleLogger = console): ModuleLogger {
  const p = `[${id}]`;
  return {
    log: (...a: unknown[]) => base.log(p, ...a),
    warn: (...a: unknown[]) => base.warn(p, ...a),
    error: (...a: unknown[]) => base.error(p, ...a),
  };
}

export interface ContextOptions {
  env: Env;
  registry: ToolRegistry;
  log?: ModuleLogger;
  /** Route sink; defaults to a no-op that warns (used by hosts without HTTP, like the remote runner). */
  http?: ModuleHttp;
}

export function createContext(manifest: ModuleManifest, o: ContextOptions): ModuleContext {
  const log = prefixedLogger(manifest.id, o.log);
  return {
    defineTool: <A>(tool: Tool<A>) => o.registry.add(manifest.id, tool),
    config: envConfig(manifest, o.env),
    log,
    http: o.http ?? { route: (method, path) => log.warn(`route ${method} ${path} ignored: this host has no HTTP server`) },
  };
}
