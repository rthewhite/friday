/** Loads in-process modules against core's registry with failure isolation. */
import {
  assertConfig,
  createContext,
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
}

export interface ModuleHostOptions {
  env?: Env;
  log?: ModuleLogger;
  /** Comma-separated module ids to enable; undefined enables all. */
  enabled?: string;
}

export class ModuleHost {
  private readonly entries: { module: FridayModule; status: ModuleStatus; error?: string }[] = [];
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
      if (only && !only.includes(id)) {
        this.entries.push({ module, status: "disabled" });
        continue;
      }
      try {
        validateManifest(module.manifest);
        assertConfig(module.manifest, this.env);
        await module.init(createContext(module.manifest, { env: this.env, registry: this.registry, log: this.log }));
        this.entries.push({ module, status: "loaded" });
        this.log.log(`module ${id}: ${this.registry.names(id).join(", ") || "(no tools)"}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.registry.removeOwner(id);
        this.entries.push({ module, status: "failed", error });
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
    }));
  }

  /** Reverse load order; individual failures are logged, not thrown. */
  async dispose(): Promise<void> {
    for (const e of [...this.entries].reverse()) {
      if (e.status !== "loaded" || !e.module.dispose) continue;
      try {
        await e.module.dispose();
      } catch (err) {
        this.log.error(`module ${e.module.manifest.id} failed to dispose:`, err);
      }
    }
  }
}
