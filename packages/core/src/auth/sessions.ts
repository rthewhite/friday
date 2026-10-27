/**
 * Browser sessions in friday.db. The cookie carries a random 256-bit token; only its SHA-256 is stored. The
 * provider's refresh token is sealed with the master key (AAD `auth:session` / `refresh_token`) and used to refresh
 * the session's claims once they are a day old. A session ends after 30 days without use.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decrypt, encrypt } from "../secrets/crypto.js";

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const CLAIMS_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Last-used times closer together than this are not written again, so a busy page doesn't write per request. */
const TOUCH_MS = 60 * 1000;
/** 32 random bytes as base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const SEAL_SCOPE = "auth";
const SEAL_KEY = "session/refresh_token";

export interface Session {
  /** SHA-256 of the cookie token; the session's id inside Friday. */
  id: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string;
  refreshedAt: string;
  /** The claims are older than a day and should be refreshed before this request is handled. */
  refreshDue: boolean;
}

interface Row {
  token_hash: string;
  user_id: string;
  created_at: string;
  last_used_at: string;
  refreshed_at: string;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class SessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Start a session for `userId`; returns the cookie token, which is not kept. */
  create(userId: string, refreshToken?: string): string {
    const token = randomBytes(32).toString("base64url");
    const at = this.now().toISOString();
    const sealed = this.seal(refreshToken);
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, refresh_token_ct, refresh_token_iv, refresh_token_tag, created_at, last_used_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.tag ?? null, at, at, at);
    return token;
  }

  /**
   * The session for a cookie token, marked as used. Undefined for a malformed or unknown token, and for a session
   * idle for 30 days, which is ended.
   */
  resolve(token: string | undefined): Session | undefined {
    if (!token || !TOKEN.test(token)) return undefined;
    const id = hashToken(token);
    const row = this.db.prepare("SELECT token_hash, user_id, created_at, last_used_at, refreshed_at FROM sessions WHERE token_hash = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const now = this.now();
    if (now.getTime() - Date.parse(row.last_used_at) >= SESSION_IDLE_MS) {
      this.end(id);
      return undefined;
    }
    let lastUsedAt = row.last_used_at;
    if (now.getTime() - Date.parse(row.last_used_at) >= TOUCH_MS) {
      lastUsedAt = now.toISOString();
      this.db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(lastUsedAt, id);
    }
    return {
      id,
      userId: row.user_id,
      createdAt: row.created_at,
      lastUsedAt,
      refreshedAt: row.refreshed_at,
      refreshDue: now.getTime() - Date.parse(row.refreshed_at) >= CLAIMS_REFRESH_MS,
    };
  }

  /** The session's refresh token; undefined when none was given or it can no longer be read. */
  refreshToken(id: string): string | undefined {
    const row = this.db.prepare("SELECT refresh_token_ct, refresh_token_iv, refresh_token_tag FROM sessions WHERE token_hash = ?").get(id) as
      | { refresh_token_ct: Uint8Array | null; refresh_token_iv: Uint8Array | null; refresh_token_tag: Uint8Array | null }
      | undefined;
    if (!row?.refresh_token_ct || !row.refresh_token_iv || !row.refresh_token_tag || !this.masterKey) return undefined;
    try {
      return decrypt(this.masterKey, SEAL_SCOPE, SEAL_KEY, {
        ciphertext: Buffer.from(row.refresh_token_ct),
        iv: Buffer.from(row.refresh_token_iv),
        tag: Buffer.from(row.refresh_token_tag),
      });
    } catch {
      return undefined;
    }
  }

  /** Record a successful claim refresh; a rotated refresh token replaces the stored one. */
  markRefreshed(id: string, refreshToken?: string): void {
    const at = this.now().toISOString();
    if (refreshToken === undefined) {
      this.db.prepare("UPDATE sessions SET refreshed_at = ? WHERE token_hash = ?").run(at, id);
      return;
    }
    const sealed = this.seal(refreshToken);
    this.db
      .prepare("UPDATE sessions SET refreshed_at = ?, refresh_token_ct = ?, refresh_token_iv = ?, refresh_token_tag = ? WHERE token_hash = ?")
      .run(at, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.tag ?? null, id);
  }

  /** End one session by its id. */
  end(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(id);
  }

  /** End the session a cookie token belongs to, if any. */
  endToken(token: string | undefined): void {
    if (token && TOKEN.test(token)) this.end(hashToken(token));
  }

  /** End every session of a user; returns how many there were. */
  endUser(userId: string): number {
    return Number(this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
  }

  private seal(value: string | undefined) {
    return value && this.masterKey ? encrypt(this.masterKey, SEAL_SCOPE, SEAL_KEY, value) : undefined;
  }
}
