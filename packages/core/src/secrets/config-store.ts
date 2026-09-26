/**
 * Encrypted configuration values by (scope, key). Scope is a module id or
 * "global". Disabled when no master key is set: reads yield nothing and writes
 * throw `ConfigStoreDisabled`.
 */
import type { DatabaseSync } from "node:sqlite";
import { decrypt, encrypt } from "./crypto.js";

export const GLOBAL_SCOPE = "global";

export class ConfigStoreDisabled extends Error {
  constructor() {
    super("configuration store is disabled: set FRIDAY_MASTER_KEY (32 bytes, base64)");
  }
}

interface Row {
  scope: string;
  key: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

export class ConfigStore {
  /** Per-boot plaintext cache; invalidated on write. `null` marks a row that failed to decrypt. */
  private readonly cache = new Map<string, string | null>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer | undefined,
    private readonly log: Pick<Console, "error"> = console,
  ) {}

  get enabled(): boolean {
    return this.masterKey !== undefined;
  }

  /** Stored plaintext, or undefined when unset, disabled, or undecryptable. */
  get(scope: string, key: string): string | undefined {
    if (!this.masterKey) return undefined;
    const id = `${scope}\0${key}`;
    if (this.cache.has(id)) return this.cache.get(id) ?? undefined;
    const row = this.db.prepare("SELECT scope, key, ciphertext, iv, tag FROM config_values WHERE scope = ? AND key = ?").get(scope, key) as Row | undefined;
    if (!row) return undefined;
    const value = this.decode(row);
    this.cache.set(id, value ?? null);
    return value ?? undefined;
  }

  /** True when a row exists, even if it cannot be decrypted. */
  has(scope: string, key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM config_values WHERE scope = ? AND key = ?").get(scope, key);
  }

  set(scope: string, key: string, value: string): void {
    if (!this.masterKey) throw new ConfigStoreDisabled();
    const e = encrypt(this.masterKey, scope, key, value);
    this.db
      .prepare("INSERT INTO config_values (scope, key, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at")
      .run(scope, key, e.ciphertext, e.iv, e.tag, new Date().toISOString());
    this.cache.delete(`${scope}\0${key}`);
  }

  delete(scope: string, key: string): boolean {
    if (!this.masterKey) throw new ConfigStoreDisabled();
    this.cache.delete(`${scope}\0${key}`);
    return this.db.prepare("DELETE FROM config_values WHERE scope = ? AND key = ?").run(scope, key).changes > 0;
  }

  /** All (scope, key) pairs on disk; values are not decrypted. */
  keys(): { scope: string; key: string }[] {
    return (this.db.prepare("SELECT scope, key FROM config_values ORDER BY scope, key").all() as { scope: string; key: string }[]).map((r) => ({ scope: r.scope, key: r.key }));
  }

  /** Decrypt every row once at boot so a wrong master key is reported immediately. Returns failures. */
  verifyAll(): { scope: string; key: string }[] {
    if (!this.masterKey) return [];
    const failed: { scope: string; key: string }[] = [];
    for (const row of this.db.prepare("SELECT scope, key, ciphertext, iv, tag FROM config_values").all() as unknown as Row[]) {
      const v = this.decode(row);
      this.cache.set(`${row.scope}\0${row.key}`, v ?? null);
      if (v === undefined) failed.push({ scope: row.scope, key: row.key });
    }
    return failed;
  }

  private decode(row: Row): string | undefined {
    try {
      return decrypt(this.masterKey!, row.scope, row.key, { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag) });
    } catch {
      this.log.error(`config: cannot decrypt ${row.scope}/${row.key}; wrong FRIDAY_MASTER_KEY? treating as unset`);
      return undefined;
    }
  }
}
