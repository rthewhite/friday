import type { DatabaseSync } from "node:sqlite";
import type { ModuleStorage } from "@friday/sdk";

/** `ctx.storage` backed by the module_kv table, namespaced by module id. */
export class SqliteModuleStorage implements ModuleStorage {
  constructor(private readonly db: DatabaseSync, private readonly moduleId: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare("SELECT value_json FROM module_kv WHERE module_id = ? AND key = ?").get(this.moduleId, key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare("INSERT INTO module_kv (module_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(module_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
      .run(this.moduleId, key, JSON.stringify(value ?? null), new Date().toISOString());
  }

  async delete(key: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM module_kv WHERE module_id = ? AND key = ?").run(this.moduleId, key).changes > 0;
  }

  async list(prefix = ""): Promise<string[]> {
    const rows = this.db.prepare("SELECT key FROM module_kv WHERE module_id = ? AND key >= ? AND key < ? ORDER BY key").all(this.moduleId, prefix, prefix + "￿") as { key: string }[];
    return rows.map((r) => r.key);
  }
}
