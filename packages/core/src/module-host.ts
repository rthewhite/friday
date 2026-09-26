/** Loads in-process modules against core's registry with failure isolation and module-scoped routes. */
import {
  assertConfig,
  createContext,
  RouteTable,
  validateManifest,
  type Env,
  type FridayModule,
  type ModuleLogger,
  type ToolRegistry,
} from "@friday/sdk";

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

export interface ModuleHostOptions {
  env?: Env;
  log?: ModuleLogger;
  /** Comma-separated module ids to enable; undefined enables all. */
  enabled?: string;
}

interface Entry {
  module: FridayModule;
  status: ModuleStatus;
  error?: string;
  routes: RouteTable;
}

export class ModuleHost {
  private readonly entries: Entry[] = [];
  private readonly env: Env;
  private readonly log: ModuleLogger;

  constructor(private readonly registry: ToolRegistry, private readonly opts: ModuleHostOptions = {}) {
    this.env = opts.env ?? process.env;
    this.log = opts.log ?? console;
  }

  async load(modules: FridayModule[]): Promise<void> {
    const only = this.opts.enabled?.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(modules.map((m) => m.manifest.id));
    for (const id of only ?? []) if (!known.has(id)) this.log.warn(`modules: FRIDAY_MODULES names unknown module "${id}"`);

    for (const module of modules) {
      const id = module.manifest?.id;
      const routes = new RouteTable();
      if (only && !only.includes(id)) {
        this.entries.push({ module, status: "disabled", routes });
        continue;
      }
      try {
        validateManifest(module.manifest);
        assertConfig(module.manifest, this.env);
        const http = { route: (method: Parameters<RouteTable["add"]>[0]["method"], path: string, handler: Parameters<RouteTable["add"]>[0]["handler"]) => routes.add({ method, path, handler }) };
        await module.init(createContext(module.manifest, { env: this.env, registry: this.registry, log: this.log, http }));
        this.entries.push({ module, status: "loaded", routes });
        const routeList = routes.list().map((r) => `${r.method} ${r.path}`);
        this.log.log(`module ${id}: ${this.registry.names(id).join(", ") || "(no tools)"}${routeList.length ? `; routes ${routeList.join(", ")}` : ""}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.registry.removeOwner(id);
        routes.clear();
        this.entries.push({ module, status: "failed", error, routes });
        this.log.error(`module ${id} failed to load: ${error}`);
      }
    }
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

  /** Route table of a loaded module, or undefined when unknown, disabled or failed. */
  routesOf(id: string): RouteTable | undefined {
    const e = this.entries.find((x) => x.module.manifest.id === id);
    return e?.status === "loaded" ? e.routes : undefined;
  }

  /** Reverse load order; individual failures are logged, not thrown. */
  async dispose(): Promise<void> {
    for (const e of [...this.entries].reverse()) {
      if (e.status !== "loaded") continue;
      e.routes.clear();
      if (!e.module.dispose) continue;
      try {
        await e.module.dispose();
      } catch (err) {
        this.log.error(`module ${e.module.manifest.id} failed to dispose:`, err);
      }
    }
  }
}
