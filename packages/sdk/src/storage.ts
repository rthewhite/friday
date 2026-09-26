/** Per-module key-value storage, JSON values, namespaced by module id. In-process modules only. */
export interface ModuleStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Keys, optionally filtered by prefix, sorted. */
  list(prefix?: string): Promise<string[]>;
}

/** In-memory implementation used by the test host. */
export class MemoryStorage implements ModuleStorage {
  private readonly map = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
