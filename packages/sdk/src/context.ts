/**
 * Building blocks shared by every host (core's in-process host, the test host and,
 * later, the remote runner): config validation and context construction.
 */
import type { ModuleHttp } from "./http.js";
import type { ModuleJobs } from "./jobs.js";
import { LlmError, type ModuleLlm } from "./llm.js";
import type { ModuleConfig, ModuleContext, ModuleLogger, ModuleManifest } from "./module.js";
import type { ToolRegistry } from "./registry.js";
import type { ModuleStorage } from "./storage.js";
import type { ModuleConversations } from "./conversations.js";
import type { ModuleDb } from "./db.js";
import type { ModulePrompt } from "./prompt.js";
import type { Tool } from "./tool.js";

export type Env = Record<string, string | undefined>;
/** Resolves a configuration key for one module; hosts compose stored values and the environment. */
export type ConfigResolver = (key: string) => string | undefined;

export const envResolver = (env: Env): ConfigResolver => (key) => env[key] || undefined;

/** Names of `required` config keys the resolver cannot satisfy. */
export function missingConfig(manifest: ModuleManifest, resolve: ConfigResolver | Env): string[] {
  const r = typeof resolve === "function" ? resolve : envResolver(resolve);
  return (manifest.config ?? []).filter((c) => c.required && !r(c.key)).map((c) => c.key);
}

/** Throws the host's standard error when a required key is unset. */
export function assertConfig(manifest: ModuleManifest, resolve: ConfigResolver | Env): void {
  const missing = missingConfig(manifest, resolve);
  if (missing.length) throw new Error(`module ${manifest.id}: missing required config ${missing.join(", ")}`);
}

/** Lazy config: every read goes through the resolver so values saved later are visible. */
export function resolvedConfig(manifest: ModuleManifest, resolve: ConfigResolver): ModuleConfig {
  return {
    get: (key) => resolve(key) || undefined,
    require(key) {
      const v = resolve(key);
      if (!v) throw new Error(`${manifest.id}: ${key} is not configured`);
      return v;
    },
  };
}

export const envConfig = (manifest: ModuleManifest, env: Env): ModuleConfig => resolvedConfig(manifest, envResolver(env));

export function prefixedLogger(id: string, base: ModuleLogger = console): ModuleLogger {
  const p = `[${id}]`;
  return {
    log: (...a: unknown[]) => base.log(p, ...a),
    warn: (...a: unknown[]) => base.warn(p, ...a),
    error: (...a: unknown[]) => base.error(p, ...a),
  };
}

export interface ContextOptions {
  /** Environment fallback; ignored when `resolve` is given. */
  env: Env;
  /** Full resolver (stored values first, then env). Defaults to `envResolver(env)`. */
  resolve?: ConfigResolver;
  registry: ToolRegistry;
  storage?: ModuleStorage;
  log?: ModuleLogger;
  /** Route sink; defaults to a no-op that warns (used by hosts without HTTP, like the remote runner). */
  http?: ModuleHttp;
  /** Job scheduler for this module; defaults to one whose `schedule` throws (hosts without a scheduler). */
  jobs?: ModuleJobs;
  /** Text generation; defaults to a facade that rejects with `unavailable` (hosts without a model provider). */
  llm?: ModuleLlm;
  /** Conversation store access; defaults to one that fails (hosts without a store, like the remote runner). */
  conversations?: ModuleConversations;
  /** The module's database handle; defaults to one whose every call throws (hosts without friday.db). */
  db?: ModuleDb;
  /** The module's prompt context; defaults to one whose `addContext` throws (hosts without prompt assembly). */
  prompt?: ModulePrompt;
}

export function createContext(manifest: ModuleManifest, o: ContextOptions): ModuleContext {
  const log = prefixedLogger(manifest.id, o.log);
  const unavailable = (what: string): ModuleStorage => {
    const fail = async () => { throw new Error(`${manifest.id}: storage is not available ${what}`); };
    return { get: fail, set: fail, delete: fail, list: fail };
  };
  return {
    defineTool: <A>(tool: Tool<A>) => o.registry.add(manifest.id, tool),
    config: resolvedConfig(manifest, o.resolve ?? envResolver(o.env)),
    log,
    http: o.http ?? { route: (method, path) => log.warn(`route ${method} ${path} ignored: this host has no HTTP server`) },
    storage: o.storage ?? unavailable("in this host"),
    jobs: o.jobs ?? {
      schedule: () => { throw new Error(`${manifest.id}: jobs are not available in this host`); },
      trigger: () => ({ started: false }),
    },
    llm: o.llm ?? { generate: async () => { throw new LlmError("unavailable", "text generation is not available in this host"); } },
    conversations: o.conversations ?? noConversations(manifest.id),
    db: o.db ?? noDb(manifest.id),
    prompt: o.prompt ?? { addContext: () => { throw new Error(`${manifest.id}: prompt context is not available in this host`); } },
  };
}

function noDb(id: string): ModuleDb {
  const fail = (): never => { throw new Error(`${id}: database is not available in this host`); };
  return { prepare: fail, exec: fail, transaction: fail };
}

function noConversations(id: string): ModuleConversations {
  const error = () => new Error(`${id}: conversations are not available in this host`);
  return {
    list: async () => { throw error(); },
    get: async () => { throw error(); },
    onQuiet: () => { throw error(); },
  };
}
