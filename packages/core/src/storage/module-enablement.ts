import type { DatabaseSync } from "node:sqlite";

/** Which in-process modules the admin switched on or off. A module without a stored choice is enabled. */
export interface ModuleEnablement {
  isEnabled(id: string): boolean;
  set(id: string, enabled: boolean): void;
}

/** The module_enablement table: one row per explicit choice. */
export class SqliteModuleEnablement implements ModuleEnablement {
  constructor(private readonly db: DatabaseSync) {}

  isEnabled(id: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM module_enablement WHERE module_id = ?").get(id) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  set(id: string, enabled: boolean): void {
    this.db
      .prepare("INSERT INTO module_enablement (module_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(module_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at")
      .run(id, enabled ? 1 : 0, new Date().toISOString());
  }
}

/** The same in memory, for tests and hosts without a database. */
export class MemoryModuleEnablement implements ModuleEnablement {
  private readonly choices = new Map<string, boolean>();

  constructor(disabled: Iterable<string> = []) {
    for (const id of disabled) this.choices.set(id, false);
  }

  isEnabled(id: string): boolean {
    return this.choices.get(id) ?? true;
  }

  set(id: string, enabled: boolean): void {
    this.choices.set(id, enabled);
  }
}
