import type { Tool } from "./tool.js";

/** A configuration value the module reads through `ctx.config`. */
export interface ConfigKey {
  key: string;
  /** When true the host refuses to load the module if the key is unset. */
  required?: boolean;
  description?: string;
}

export interface ModuleManifest {
  /** kebab-case, unique per deployment; used as tool owner and, later, URL segment. */
  id: string;
  label: string;
  description?: string;
  config?: ConfigKey[];
}

export interface ModuleConfig {
  get(key: string): string | undefined;
  /** Like `get` but throws `<module>: <key> is not configured` when unset. */
  require(key: string): string;
}

export type ModuleLogger = Pick<Console, "log" | "warn" | "error">;

/** What a module receives in `init`. Everything a module needs from Friday comes through here. */
export interface ModuleContext {
  defineTool<A>(tool: Tool<A>): Tool<A>;
  config: ModuleConfig;
  log: ModuleLogger;
}

export interface FridayModule {
  manifest: ModuleManifest;
  init(ctx: ModuleContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Identity helper that gives module authors type checking and completion. */
export const defineModule = (m: FridayModule): FridayModule => m;

const ID = /^[a-z][a-z0-9-]*$/;

/** Throws when a manifest is malformed. */
export function validateManifest(m: ModuleManifest): void {
  if (!m || typeof m.id !== "string" || !ID.test(m.id)) throw new Error(`invalid module id ${JSON.stringify(m?.id)}`);
  if (typeof m.label !== "string" || !m.label) throw new Error(`module ${m.id}: label is required`);
}
