/**
 * OAuth access for modules: a manifest requests a provider, the user connects it and grants the module
 * access in the portal (Settings > Connections), and `ctx.oauth.token(provider)` hands out a fresh access token.
 */

/** A provider the module needs a token for. Requests are listed in the portal and granted per module. */
export interface OAuthRequest {
  /** Provider id: a catalogue provider such as `spotify`, or a kebab-case id for a generic OAuth2 provider. */
  provider: string;
  /** Scopes the module needs. Friday asks the provider for the union of the granted modules' scopes. */
  scopes: string[];
  /** Why the module wants access, shown next to the grant toggle. */
  description?: string;
  /** Generic providers only: defaults for the connection's authorization URL (https). Needs `tokenUrl` too. */
  authUrl?: string;
  /** Generic providers only: defaults for the connection's token URL (https). Needs `authUrl` too. */
  tokenUrl?: string;
}

export type OAuthErrorKind = "not_connected" | "not_granted" | "refresh_failed";

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly kind: OAuthErrorKind;

  constructor(kind: OAuthErrorKind, message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.kind = kind;
  }
}

export interface ModuleOAuth {
  /**
   * A fresh access token for `provider`, refreshed first when it is about to expire. Checked on every call, so
   * connecting, granting and revoking apply without a reload. Rejects with an `OAuthError` whose message says what
   * the user can do, so a tool can pass it on.
   */
  token(provider: string): Promise<string>;
}

/** What a provider id looks like (kebab-case). */
export const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Throws when a manifest's `oauth` requests are malformed. */
export function validateOAuthRequests(moduleId: string, requests: unknown): void {
  if (requests === undefined) return;
  if (!Array.isArray(requests)) throw new Error(`module ${moduleId}: oauth must be a list`);
  const seen = new Set<string>();
  for (const r of requests as Partial<OAuthRequest>[]) {
    const provider = r?.provider;
    if (typeof provider !== "string" || !PROVIDER_ID.test(provider)) {
      throw new Error(`module ${moduleId}: invalid oauth provider ${JSON.stringify(provider)}`);
    }
    const where = `module ${moduleId}: oauth request for ${provider}`;
    if (seen.has(provider)) throw new Error(`${where} is declared twice`);
    seen.add(provider);
    if (!Array.isArray(r.scopes) || r.scopes.some((s) => typeof s !== "string" || !s.trim())) {
      throw new Error(`${where}: scopes must be a list of strings`);
    }
    if (r.description !== undefined && typeof r.description !== "string") throw new Error(`${where}: description must be a string`);
    if ((r.authUrl === undefined) !== (r.tokenUrl === undefined)) throw new Error(`${where}: authUrl and tokenUrl go together`);
    if (r.authUrl !== undefined && (!httpsUrl(r.authUrl) || !httpsUrl(r.tokenUrl))) {
      throw new Error(`${where}: authUrl and tokenUrl must be https URLs`);
    }
  }
}

/** The facade hosts without connections (the remote runner) give modules. */
export const noOAuth: ModuleOAuth = {
  token: async () => { throw new OAuthError("not_connected", "OAuth connections are not available in this host"); },
};
