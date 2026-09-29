/** Loads in-process modules against core's registry with failure isolation, module routes, and reload. */
import {
  assertConfig,
  createContext,
  envResolver,
  prefixedLogger,
  RouteTable,
  validateManifest,
  type ConfigResolver,
  type Env,
  type FridayModule,
  type ModuleJobs,
  type ModuleLlm,
  type ModuleConversations,
  type ModuleLogger,
  type ModuleStorage,
  type PromptContext,
  type ToolRegistry,
} from "@friday/sdk";
import { lazyDb, openModuleDb, type ModuleDatabase } from "@friday/sdk/db";

export type ModuleStatus = "loaded" | "failed" | "disabled";

export interface ModuleEntry {
  id: string;
  label: string;
  description?: string;
  status: ModuleStatus;
  error?: string;
  tools: string[];
  ui: boolean;
}

/** A module's jobs plus the hook that removes them and cancels in-flight runs (waiting up to a grace period). */
export interface HostJobs extends ModuleJobs {
  removeAll(): Promise<void>;
}

export interface ModuleHostOptions {
  env?: Env;
  log?: ModuleLogger;
  /** Comma-separated module ids to enable; undefined enables all. */
  enabled?: string;
  /** Per-module config resolver (stored values then env). Defaults to env only. */
  resolve?: (moduleId: string) => ConfigResolver;
  /** Per-module persistent storage. Defaults to an unavailable stub. */
  storage?: (moduleId: string) => ModuleStorage;
  /** Per-module job scheduler (`scheduler.forOwner`). Defaults to unavailable. */
  jobs?: (moduleId: string) => HostJobs;
  /** Per-module text generation (calls attributed to the id). Defaults to an unavailable stub. */
  llm?: (moduleId: string) => ModuleLlm;
  /** Per-module conversation access. Defaults to an unavailable stub. */
  conversations?: (moduleId: string) => ModuleConversations;
  /**
   * Path of friday.db. Each module gets its own connection on it, opened on its first migration or
   * `ctx.db` call. Without it `ctx.db` is unavailable and a module that declares migrations fails.
   */
  database?: string;
  /** Registry the modules' prompt context providers join. Without it `ctx.prompt` is unavailable. */
  prompt?: PromptContext;
}

interface Entry {
  module: FridayModule;
  status: ModuleStatus;
  error?: string;
  routes: RouteTable;
  /** The module's connection; kept across reloads, closed in `dispose`. */
  database?: ModuleDatabase;
}

export class ModuleHost {
  private readonly entries: Entry[] = [];
  private readonly env: Env;
  private readonly log: ModuleLogger;
  private readonly resolve: (moduleId: string) => ConfigResolver;
  /** Unsubscribers of each module's onQuiet handlers, dropped on teardown and failed init. */
  private readonly quietSubs = new Map<string, (() => void)[]>();
  /** Set by `dispose`: module connections are closed and must not reopen. */
  private disposed = false;

  constructor(private readonly registry: ToolRegistry, private readonly opts: ModuleHostOptions = {}) {
    this.env = opts.env ?? process.env;
    this.log = opts.log ?? console;
    this.resolve = opts.resolve ?? (() => envResolver(this.env));
  }

  async load(modules: FridayModule[]): Promise<void> {
    const only = this.opts.enabled?.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(modules.map((m) => m.manifest.id));
    for (const id of only ?? []) if (!known.has(id)) this.log.warn(`modules: FRIDAY_MODULES names unknown module "${id}"`);

    for (const module of modules) {
      const entry: Entry = { module, status: "disabled", routes: new RouteTable() };
      this.entries.push(entry);
      if (only && !only.includes(module.manifest?.id)) continue;
      await this.init(entry);
    }
  }

  /** Dispose (if loaded) and initialize again with current configuration. Returns the new entry. */
  async reload(id: string): Promise<ModuleEntry | undefined> {
    const entry = this.entries.find((e) => e.module.manifest.id === id);
    if (!entry || entry.status === "disabled") return undefined;
    if (entry.status === "loaded") await this.teardown(entry);
    await this.init(entry);
    return this.loaded().find((e) => e.id === id);
  }

  private async init(entry: Entry): Promise<void> {
    const { module, routes } = entry;
    const id = module.manifest?.id;
    try {
      validateManifest(module.manifest);
      const resolve = this.resolve(id);
      assertConfig(module.manifest, resolve);
      if (module.migrations?.length) {
        if (!this.opts.database) throw new Error(`${id}: database is not available in this host`);
        this.databaseOf(entry).migrate(module.migrations, prefixedLogger(id, this.log));
      }
      const db = this.opts.database ? lazyDb(() => this.databaseOf(entry)) : undefined;
      const http = { route: (method: Parameters<RouteTable["add"]>[0]["method"], path: string, handler: Parameters<RouteTable["add"]>[0]["handler"]) => routes.add({ method, path, handler }) };
      await module.init(createContext(module.manifest, { env: this.env, resolve, registry: this.registry, log: this.log, http, storage: this.opts.storage?.(id), jobs: this.opts.jobs?.(id), llm: this.opts.llm?.(id), conversations: this.conversationsFor(id), db, prompt: this.opts.prompt?.forOwner(id) }));
      entry.status = "loaded";
      entry.error = undefined;
      const routeList = routes.list().map((r) => `${r.method} ${r.path}`);
      this.log.log(`module ${id}: ${this.registry.names(id).join(", ") || "(no tools)"}${routeList.length ? `; routes ${routeList.join(", ")}` : ""}`);
    } catch (e) {
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
      this.registry.removeOwner(id);
      routes.clear();
      await this.opts.jobs?.(id).removeAll();
      this.dropSubscriptions(id);
      this.opts.prompt?.clear(id);
      this.log.error(`module ${id} failed to load: ${entry.error}`);
    }
  }

  private async teardown(entry: Entry): Promise<void> {
    const id = entry.module.manifest.id;
    entry.routes.clear();
    this.registry.removeOwner(id);
    // Stop the module's timers and let in-flight runs settle before the module releases its resources.
    await this.opts.jobs?.(id).removeAll();
    this.dropSubscriptions(id);
    this.opts.prompt?.clear(id);
    try {
      await entry.module.dispose?.();
    } catch (err) {
      this.log.error(`module ${id} failed to dispose:`, err);
    }
  }

  /** The module's connection on friday.db, opened on first use. */
  private databaseOf(entry: Entry): ModuleDatabase {
    if (this.disposed) throw new Error(`${entry.module.manifest.id}: database is closed (Friday is shutting down)`);
    return (entry.database ??= openModuleDb(this.opts.database!, entry.module.manifest.id));
  }

  /** `ctx.conversations` with its onQuiet subscriptions tracked so a reload or dispose can drop them. */
  private conversationsFor(id: string): ModuleConversations | undefined {
    const c = this.opts.conversations?.(id);
    if (!c) return undefined;
    return {
      ...c,
      onQuiet: (handler) => {
        const off = c.onQuiet(handler);
        this.quietSubs.set(id, [...(this.quietSubs.get(id) ?? []), off]);
        return off;
      },
    };
  }

  private dropSubscriptions(id: string): void {
    for (const off of this.quietSubs.get(id) ?? []) off();
    this.quietSubs.delete(id);
  }

  loaded(): ModuleEntry[] {
    return this.entries.map(({ module: { manifest }, status, error }) => ({
      id: manifest.id,
      label: manifest.label,
      description: manifest.description,
      status,
      ...(error ? { error } : {}),
      tools: status === "loaded" ? this.registry.names(manifest.id) : [],
      ui: manifest.ui === true,
    }));
  }

  /** Manifests of every known module (any status), for configuration listing. */
  manifests() {
    return this.entries.map((e) => ({ manifest: e.module.manifest, status: e.status }));
  }

  /** Route table of a loaded module, or undefined when unknown, disabled or failed. */
  routesOf(id: string): RouteTable | undefined {
    const e = this.entries.find((x) => x.module.manifest.id === id);
    return e?.status === "loaded" ? e.routes : undefined;
  }

  /** Reverse load order; individual failures are logged, not thrown. Then closes the modules' connections. */
  async dispose(): Promise<void> {
    for (const e of [...this.entries].reverse()) {
      if (e.status !== "loaded") continue;
      await this.teardown(e);
    }
    this.disposed = true;
    for (const e of this.entries) {
      try {
        e.database?.close();
      } catch (err) {
        this.log.error(`module ${e.module.manifest.id}: closing its database failed:`, err);
      }
      e.database = undefined;
    }
  }
}
