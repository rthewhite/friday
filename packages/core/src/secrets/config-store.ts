/**
 * Configuration values by (scope, key). Scope is a module id or "global".
 * Secret values are AES-256-GCM encrypted with the master key; plain values are
 * stored as plaintext and work without one. Without a master key secret reads
 * yield nothing and secret writes throw `ConfigStoreDisabled`.
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
  secret: number;
  plaintext: string | null;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

export interface StoredKey {
  scope: string;
  key: string;
  secret: boolean;
}

const SELECT = "SELECT scope, key, secret, plaintext, ciphertext, iv, tag FROM config_values";
const EMPTY = new Uint8Array(0);

export class ConfigStore {
  /** Per-boot plaintext cache; invalidated on write. `null` marks a row that failed to decrypt. */
  private readonly cache = new Map<string, string | null>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer | undefined,
    private readonly log: Pick<Console, "error"> = console,
  ) {}

  /** True when secrets can be written and read; plain values never depend on this. */
  get secretsEnabled(): boolean {
    return this.masterKey !== undefined;
  }

  /** Stored value, or undefined when unset, secret without a master key, or undecryptable. */
  get(scope: string, key: string): string | undefined {
    const id = `${scope}\0${key}`;
    if (this.cache.has(id)) return this.cache.get(id) ?? undefined;
    const row = this.db.prepare(`${SELECT} WHERE scope = ? AND key = ?`).get(scope, key) as unknown as Row | undefined;
    if (!row) return undefined;
    const value = this.decode(row);
    this.cache.set(id, value ?? null);
    return value ?? undefined;
  }

  /** Whether a row exists and how it is stored, even if it cannot be decrypted. */
  info(scope: string, key: string): { secret: boolean } | undefined {
    const row = this.db.prepare("SELECT secret FROM config_values WHERE scope = ? AND key = ?").get(scope, key) as { secret: number } | undefined;
    return row ? { secret: row.secret === 1 } : undefined;
  }

  set(scope: string, key: string, value: string, opts: { secret: boolean }): void {
    const now = new Date().toISOString();
    if (opts.secret) {
      if (!this.masterKey) throw new ConfigStoreDisabled();
      const e = encrypt(this.masterKey, scope, key, value);
      this.db
        .prepare("INSERT INTO config_values (scope, key, secret, plaintext, ciphertext, iv, tag, updated_at) VALUES (?, ?, 1, NULL, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET secret = 1, plaintext = NULL, ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at")
        .run(scope, key, e.ciphertext, e.iv, e.tag, now);
    } else {
      this.db
        .prepare("INSERT INTO config_values (scope, key, secret, plaintext, ciphertext, iv, tag, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET secret = 0, plaintext = excluded.plaintext, ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at")
        .run(scope, key, value, EMPTY, EMPTY, EMPTY, now);
    }
    this.cache.delete(`${scope}\0${key}`);
  }

  delete(scope: string, key: string): boolean {
    this.cache.delete(`${scope}\0${key}`);
    return this.db.prepare("DELETE FROM config_values WHERE scope = ? AND key = ?").run(scope, key).changes > 0;
  }

  /** All rows on disk with their storage kind; values are not decrypted. */
  keys(): StoredKey[] {
    return (this.db.prepare("SELECT scope, key, secret FROM config_values ORDER BY scope, key").all() as { scope: string; key: string; secret: number }[]).map((r) => ({ scope: r.scope, key: r.key, secret: r.secret === 1 }));
  }

  /** Decrypt every secret row once at boot so a wrong master key is reported immediately. Returns failures. */
  verifyAll(): { scope: string; key: string }[] {
    if (!this.masterKey) return [];
    const failed: { scope: string; key: string }[] = [];
    for (const row of this.db.prepare(`${SELECT} WHERE secret = 1`).all() as unknown as Row[]) {
      const v = this.decode(row);
      this.cache.set(`${row.scope}\0${row.key}`, v ?? null);
      if (v === undefined) failed.push({ scope: row.scope, key: row.key });
    }
    return failed;
  }

  private decode(row: Row): string | undefined {
    if (row.secret !== 1) return row.plaintext ?? undefined;
    if (!this.masterKey) return undefined;
    try {
      return decrypt(this.masterKey!, row.scope, row.key, { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag) });
    } catch {
      this.log.error(`config: cannot decrypt ${row.scope}/${row.key}; wrong FRIDAY_MASTER_KEY? treating as unset`);
      return undefined;
    }
  }
}
