import type { ModuleHttp } from "./http.js";
import type { ModuleJobs } from "./jobs.js";
import type { ModuleLlm } from "./llm.js";
import type { ModuleStorage } from "./storage.js";
import type { ModuleConversations } from "./conversations.js";
import type { ModuleDb, ModuleMigration } from "./db.js";
import type { ModulePrompt } from "./prompt.js";
import type { Tool } from "./tool.js";

/** A configuration value the module reads through `ctx.config`. */
export interface ConfigKey {
  key: string;
  /** When true the host refuses to load the module if the key is unset. */
  required?: boolean;
  description?: string;
  /** Credentials and tokens: stored encrypted and never shown in the portal. Retrieval is unchanged. */
  secret?: boolean;
}

export interface ModuleManifest {
  /** kebab-case, unique per deployment; used as tool owner and, later, URL segment. */
  id: string;
  label: string;
  description?: string;
  config?: ConfigKey[];
  /** True when the module package ships a portal UI (`friday.ui` in its package.json). */
  ui?: boolean;
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
  /** Module-scoped HTTP routes served at /api/modules/<id>/. Not available to remote modules. */
  http: ModuleHttp;
  /** Persistent key-value storage namespaced to this module. Not available to remote modules. */
  storage: ModuleStorage;
  /** Scheduled background jobs owned by this module. Not available to remote modules. */
  jobs: ModuleJobs;
  /** Text generation through core's model. Rejects with `unavailable` in hosts without a model (remote modules). */
  llm: ModuleLlm;
  /** Read access to recorded conversations, and quiet notifications. Not available to remote modules. */
  conversations: ModuleConversations;
  /**
   * Synchronous access to the module's own tables (`<prefix>__*`) in friday.db, created by `migrations`.
   * Not available to remote modules.
   */
  db: ModuleDb;
  /** Adds text to Friday's voice and chat system prompts. Not available to remote modules. */
  prompt: ModulePrompt;
}

export interface FridayModule {
  manifest: ModuleManifest;
  init(ctx: ModuleContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
  /** Schema steps for the module's tables; the host runs pending ones before `init`. Ignored by remote hosts. */
  migrations?: ModuleMigration[];
}

/** Identity helper that gives module authors type checking and completion. */
export const defineModule = (m: FridayModule): FridayModule => m;

/** What a module id looks like; table prefixes (`db.ts`) rely on it too. */
export const MODULE_ID = /^[a-z][a-z0-9-]*$/;
/** Ids core uses as an owner itself (job ids are `<owner>/<name>`). */
const RESERVED_IDS = ["core"];

/** Throws when a manifest is malformed. */
export function validateManifest(m: ModuleManifest): void {
  if (!m || typeof m.id !== "string" || !MODULE_ID.test(m.id)) throw new Error(`invalid module id ${JSON.stringify(m?.id)}`);
  if (RESERVED_IDS.includes(m.id)) throw new Error(`module id "${m.id}" is reserved`);
  if (typeof m.label !== "string" || !m.label) throw new Error(`module ${m.id}: label is required`);
}
