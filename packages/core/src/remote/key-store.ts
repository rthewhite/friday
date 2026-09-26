/** Resolves a remote module's API key to the module id it may register as. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface KeyStore {
  lookup(key: string): Promise<string | undefined> | string | undefined;
  /** True when no key can ever match; used for the startup warning. */
  isEmpty(): boolean;
}

/** `FRIDAY_MODULE_KEYS="<id>=<key>,<id2>=<key2>"`. */
export function parseModuleKeys(value: string | undefined): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0 || eq === p.length - 1) throw new Error(`FRIDAY_MODULE_KEYS: expected <id>=<key>, got "${p}"`);
    byKey.set(p.slice(eq + 1), p.slice(0, eq));
  }
  return byKey;
}

export class EnvKeyStore implements KeyStore {
  private readonly byKey: Map<string, string>;
  constructor(value: string | undefined) {
    this.byKey = parseModuleKeys(value);
  }
  lookup(key: string): string | undefined {
    return this.byKey.get(key);
  }
  isEmpty(): boolean {
    return this.byKey.size === 0;
  }
}

export interface ModuleKeyRecord {
  id: string;
  moduleId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Portal-issued keys, hashed at rest. */
export class SqliteKeyStore implements KeyStore {
  constructor(private readonly db: DatabaseSync) {}

  lookup(key: string): string | undefined {
    const row = this.db.prepare("SELECT id, module_id FROM module_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hashKey(key)) as { id: string; module_id: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE module_keys SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return row.module_id;
  }

  isEmpty(): boolean {
    return !this.db.prepare("SELECT 1 FROM module_keys WHERE revoked_at IS NULL LIMIT 1").get();
  }

  /** Returns the plaintext key exactly once. */
  create(moduleId: string, label: string): { record: ModuleKeyRecord; key: string } {
    const key = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO module_keys (id, module_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, moduleId, hashKey(key), label, createdAt);
    return { record: { id, moduleId, label, createdAt, lastSeenAt: null, revoked: false }, key };
  }

  list(): ModuleKeyRecord[] {
    const rows = this.db.prepare("SELECT id, module_id, label, created_at, last_seen_at, revoked_at FROM module_keys ORDER BY created_at").all() as Array<{ id: string; module_id: string; label: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }>;
    return rows.map((r) => ({ id: r.id, moduleId: r.module_id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, revoked: r.revoked_at !== null }));
  }

  /** Marks the key revoked; returns its module id, or undefined when unknown. */
  revoke(id: string): string | undefined {
    const row = this.db.prepare("SELECT module_id FROM module_keys WHERE id = ? AND revoked_at IS NULL").get(id) as { module_id: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE module_keys SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return row.module_id;
  }
}

/** Stored keys first, then the environment, so existing deployments keep working. */
export class CompositeKeyStore implements KeyStore {
  constructor(private readonly stores: KeyStore[]) {}
  async lookup(key: string): Promise<string | undefined> {
    for (const s of this.stores) {
      const id = await s.lookup(key);
      if (id) return id;
    }
    return undefined;
  }
  isEmpty(): boolean {
    return this.stores.every((s) => s.isEmpty());
  }
}
