/**
 * OAuth connections and grants in friday.db. The client secret and both tokens are AES-256-GCM sealed with the
 * master key (AAD `oauth:<provider>` / `<field>`) and leave the store only through `secrets()`, for the flow and the
 * token service. The listing never carries them.
 */
import type { DatabaseSync } from "node:sqlite";
import { PROVIDER_ID } from "@friday/sdk";
import { decrypt, encrypt, type Encrypted } from "../secrets/crypto.js";
import { catalogueEntry } from "./catalogue.js";

export type ConnectionState = "disconnected" | "connected" | "error";

/** A connection as written by the API. Leaving `clientSecret` out keeps the stored one. */
export interface ConnectionInput {
  provider: string;
  clientId: string;
  clientSecret?: string;
  extraScopes?: string[];
  /** Generic providers only. */
  authUrl?: string;
  tokenUrl?: string;
}

/** A connection without its secrets. */
export interface StoredConnection {
  provider: string;
  clientId: string;
  hasClientSecret: boolean;
  authUrl?: string;
  tokenUrl?: string;
  extraScopes: string[];
  /** What the provider granted at the last authorization; undefined before the first one. */
  grantedScopes?: string[];
  state: ConnectionState;
  error?: string;
  /** ISO time the access token expires; undefined when the provider gave none. */
  expiresAt?: string;
  hasTokens: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionSecrets {
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface NewTokens {
  accessToken: string;
  /** Undefined keeps the stored refresh token (providers that don't rotate). */
  refreshToken?: string;
  expiresAt?: Date;
  grantedScopes?: string[];
}

/** Invalid input; maps to 400. */
export class OAuthInputError extends Error {}

/** No master key, so nothing can be sealed or read; maps to 503. */
export class OAuthStoreDisabled extends Error {
  constructor() {
    super("OAuth connections need FRIDAY_MASTER_KEY (32 bytes, base64)");
  }
}

/** A sealed value could not be read (wrong master key or tampered row). The connection is put in `error`. */
export class OAuthDecryptError extends Error {}

type Field = "client_secret" | "access_token" | "refresh_token";

interface Row {
  provider: string;
  client_id: string;
  client_secret_ct: Uint8Array | null;
  client_secret_iv: Uint8Array | null;
  client_secret_tag: Uint8Array | null;
  auth_url: string | null;
  token_url: string | null;
  extra_scopes_json: string;
  access_token_ct: Uint8Array | null;
  access_token_iv: Uint8Array | null;
  access_token_tag: Uint8Array | null;
  refresh_token_ct: Uint8Array | null;
  refresh_token_iv: Uint8Array | null;
  refresh_token_tag: Uint8Array | null;
  expires_at: string | null;
  granted_scopes_json: string | null;
  state: ConnectionState;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const aadScope = (provider: string) => `oauth:${provider}`;

const httpsUrl = (v: string): boolean => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** Validates an API body for `PUT /api/oauth/connections/:provider`. @throws OAuthInputError */
export function parseConnectionInput(provider: string, body: unknown): ConnectionInput {
  if (!PROVIDER_ID.test(provider)) throw new OAuthInputError(`provider must be kebab-case, got ${JSON.stringify(provider)}`);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthInputError("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.clientId !== "string" || !b.clientId.trim()) throw new OAuthInputError("clientId is required");
  const input: ConnectionInput = { provider, clientId: b.clientId.trim() };
  if (b.clientSecret !== undefined) {
    if (typeof b.clientSecret !== "string" || !b.clientSecret) throw new OAuthInputError("clientSecret must be a non-empty string; leave it out to keep the stored one");
    input.clientSecret = b.clientSecret;
  }
  if (b.extraScopes !== undefined) {
    if (!Array.isArray(b.extraScopes) || b.extraScopes.some((s) => typeof s !== "string" || !s.trim() || /\s/.test(s.trim()))) {
      throw new OAuthInputError("extraScopes must be a list of scopes without spaces");
    }
    input.extraScopes = [...new Set((b.extraScopes as string[]).map((s) => s.trim()))];
  }
  const generic = !catalogueEntry(provider);
  for (const key of ["authUrl", "tokenUrl"] as const) {
    const v = b[key];
    if (!generic) {
      if (v !== undefined) throw new OAuthInputError(`${key} is only for generic providers; ${provider} uses its own endpoints`);
      continue;
    }
    if (typeof v !== "string" || !v.trim()) throw new OAuthInputError(`a generic provider needs ${key}`);
    if (!httpsUrl(v.trim())) throw new OAuthInputError(`${key} must be an https URL`);
    input[key] = v.trim();
  }
  return input;
}

export class OAuthStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer | undefined,
    private readonly log: Pick<Console, "error"> = console,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get secretsEnabled(): boolean {
    return this.masterKey !== undefined;
  }

  list(): StoredConnection[] {
    return (this.db.prepare("SELECT * FROM oauth_connections ORDER BY provider").all() as unknown as Row[]).map(toStored);
  }

  get(provider: string): StoredConnection | undefined {
    const row = this.row(provider);
    return row && toStored(row);
  }

  /**
   * Create or update. A new connection starts `disconnected`. A changed client id, a new client secret or a changed
   * URL clears the tokens (they belong to the old client) and sets `disconnected`; extra scopes alone keep them.
   * @throws OAuthStoreDisabled
   */
  upsert(input: ConnectionInput): StoredConnection {
    if (!this.masterKey) throw new OAuthStoreDisabled();
    const now = this.now().toISOString();
    const prev = this.row(input.provider);
    const secret = input.clientSecret !== undefined ? this.seal(input.provider, "client_secret", input.clientSecret) : undefined;
    if (!prev) {
      this.db
        .prepare(`INSERT INTO oauth_connections (provider, client_id, client_secret_ct, client_secret_iv, client_secret_tag, auth_url, token_url,
                  extra_scopes_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', ?, ?)`)
        .run(input.provider, input.clientId, secret?.ciphertext ?? null, secret?.iv ?? null, secret?.tag ?? null,
          input.authUrl ?? null, input.tokenUrl ?? null, JSON.stringify(input.extraScopes ?? []), now, now);
      return this.get(input.provider)!;
    }
    const newClient = input.clientId !== prev.client_id || secret !== undefined
      || (input.authUrl ?? null) !== prev.auth_url || (input.tokenUrl ?? null) !== prev.token_url;
    this.tx(() => {
      this.db
        .prepare("UPDATE oauth_connections SET client_id = ?, auth_url = ?, token_url = ?, extra_scopes_json = ?, updated_at = ? WHERE provider = ?")
        .run(input.clientId, input.authUrl ?? null, input.tokenUrl ?? null, JSON.stringify(input.extraScopes ?? JSON.parse(prev.extra_scopes_json)), now, input.provider);
      if (secret) {
        this.db
          .prepare("UPDATE oauth_connections SET client_secret_ct = ?, client_secret_iv = ?, client_secret_tag = ? WHERE provider = ?")
          .run(secret.ciphertext, secret.iv, secret.tag, input.provider);
      }
      if (newClient) this.clearTokens(input.provider);
    });
    return this.get(input.provider)!;
  }

  /** Removes the connection, its tokens and, by cascade, its grants. */
  delete(provider: string): boolean {
    return this.db.prepare("DELETE FROM oauth_connections WHERE provider = ?").run(provider).changes > 0;
  }

  /**
   * The connection's secrets in plaintext. A value that cannot be read is logged and puts the connection in `error`.
   * @throws OAuthStoreDisabled, OAuthDecryptError
   */
  secrets(provider: string): ConnectionSecrets {
    const row = this.row(provider);
    if (!row) return {};
    if (!this.masterKey) throw new OAuthStoreDisabled();
    const out: ConnectionSecrets = {};
    const fields: [Field, keyof ConnectionSecrets][] = [["client_secret", "clientSecret"], ["access_token", "accessToken"], ["refresh_token", "refreshToken"]];
    for (const [field, key] of fields) {
      const sealed = sealedField(row, field);
      if (!sealed) continue;
      try {
        out[key] = decrypt(this.masterKey, aadScope(provider), field, sealed);
      } catch {
        const message = `the stored ${field.replace("_", " ")} cannot be decrypted; wrong FRIDAY_MASTER_KEY? Save the connection again and reconnect`;
        this.log.error(`oauth: ${provider}: ${message}`);
        this.setError(provider, message);
        throw new OAuthDecryptError(message);
      }
    }
    return out;
  }

  /** Stores tokens after an authorization or a refresh and sets `connected`. One statement, so it lands whole. */
  storeTokens(provider: string, t: NewTokens): void {
    if (!this.masterKey) throw new OAuthStoreDisabled();
    const access = this.seal(provider, "access_token", t.accessToken);
    const refresh = t.refreshToken !== undefined ? this.seal(provider, "refresh_token", t.refreshToken) : undefined;
    this.db
      .prepare(`UPDATE oauth_connections SET access_token_ct = ?, access_token_iv = ?, access_token_tag = ?,
                refresh_token_ct = COALESCE(?, refresh_token_ct), refresh_token_iv = COALESCE(?, refresh_token_iv), refresh_token_tag = COALESCE(?, refresh_token_tag),
                expires_at = ?, granted_scopes_json = COALESCE(?, granted_scopes_json), state = 'connected', error = NULL, updated_at = ?
                WHERE provider = ?`)
      .run(access.ciphertext, access.iv, access.tag, refresh?.ciphertext ?? null, refresh?.iv ?? null, refresh?.tag ?? null,
        t.expiresAt?.toISOString() ?? null, t.grantedScopes ? JSON.stringify(t.grantedScopes) : null, this.now().toISOString(), provider);
  }

  setError(provider: string, message: string): void {
    this.db.prepare("UPDATE oauth_connections SET state = 'error', error = ?, updated_at = ? WHERE provider = ?").run(message, this.now().toISOString(), provider);
  }

  grants(provider: string): string[] {
    return (this.db.prepare("SELECT module_id FROM oauth_grants WHERE provider = ? ORDER BY module_id").all(provider) as { module_id: string }[]).map((r) => r.module_id);
  }

  hasGrant(provider: string, moduleId: string): boolean {
    return this.db.prepare("SELECT 1 FROM oauth_grants WHERE provider = ? AND module_id = ?").get(provider, moduleId) !== undefined;
  }

  /** Returns false when the connection does not exist. */
  grant(provider: string, moduleId: string): boolean {
    if (!this.row(provider)) return false;
    this.db.prepare("INSERT OR IGNORE INTO oauth_grants (provider, module_id, granted_at) VALUES (?, ?, ?)").run(provider, moduleId, this.now().toISOString());
    return true;
  }

  revoke(provider: string, moduleId: string): boolean {
    return this.db.prepare("DELETE FROM oauth_grants WHERE provider = ? AND module_id = ?").run(provider, moduleId).changes > 0;
  }

  private clearTokens(provider: string): void {
    this.db
      .prepare(`UPDATE oauth_connections SET access_token_ct = NULL, access_token_iv = NULL, access_token_tag = NULL,
                refresh_token_ct = NULL, refresh_token_iv = NULL, refresh_token_tag = NULL, expires_at = NULL, granted_scopes_json = NULL,
                state = 'disconnected', error = NULL WHERE provider = ?`)
      .run(provider);
  }

  private seal(provider: string, field: Field, value: string): Encrypted {
    if (!this.masterKey) throw new OAuthStoreDisabled();
    return encrypt(this.masterKey, aadScope(provider), field, value);
  }

  private row(provider: string): Row | undefined {
    return this.db.prepare("SELECT * FROM oauth_connections WHERE provider = ?").get(provider) as unknown as Row | undefined;
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function sealedField(row: Row, field: Field): Encrypted | undefined {
  const ct = row[`${field}_ct`];
  const iv = row[`${field}_iv`];
  const tag = row[`${field}_tag`];
  if (!ct || !iv || !tag) return undefined;
  return { ciphertext: Buffer.from(ct), iv: Buffer.from(iv), tag: Buffer.from(tag) };
}

function toStored(r: Row): StoredConnection {
  const s: StoredConnection = {
    provider: r.provider,
    clientId: r.client_id,
    hasClientSecret: r.client_secret_ct !== null,
    extraScopes: JSON.parse(r.extra_scopes_json) as string[],
    state: r.state,
    hasTokens: r.access_token_ct !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.auth_url !== null) s.authUrl = r.auth_url;
  if (r.token_url !== null) s.tokenUrl = r.token_url;
  if (r.granted_scopes_json !== null) s.grantedScopes = JSON.parse(r.granted_scopes_json) as string[];
  if (r.error !== null) s.error = r.error;
  if (r.expires_at !== null) s.expiresAt = r.expires_at;
  return s;
}
