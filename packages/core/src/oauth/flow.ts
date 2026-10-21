/**
 * The authorization code flow. `start` builds the provider's authorization URL with a random state (and a PKCE
 * verifier when the provider uses one) and remembers it in memory for 10 minutes; `finish` checks the state against
 * the cookie and the pending entry before anything is sent to the provider, uses it once, exchanges the code and
 * stores the tokens. A restart during a login drops it; the user clicks Connect again.
 */
import * as arctic from "arctic";
import { buildClient as defaultBuildClient, clientConfig, generateCodeVerifier, generateState, providerName, type BuildClient } from "./catalogue.js";
import type { OAuthRequests } from "./requests.js";
import { OAuthDecryptError, OAuthStoreDisabled, type OAuthStore } from "./store.js";
import { providerMessage, reportedScopes, tokenExpiry } from "./tokens.js";
import { redirectUri } from "./redirect.js";

export const STATE_TTL_MS = 10 * 60_000;

interface Pending {
  provider: string;
  /** The client the login was started with; a connection saved with another one meanwhile refuses the callback. */
  clientId: string;
  verifier?: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

/** A start that cannot proceed; `status` is the HTTP status to answer with. */
export class OAuthFlowError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type FinishResult = { ok: true } | { ok: false; error: string };

export interface OAuthFlowOptions {
  store: OAuthStore;
  requests: OAuthRequests;
  buildClient?: BuildClient;
  now?: () => number;
}

export class OAuthFlow {
  private readonly pending = new Map<string, Pending>();
  private readonly buildClient: BuildClient;
  private readonly now: () => number;

  constructor(private readonly o: OAuthFlowOptions) {
    this.buildClient = o.buildClient ?? defaultBuildClient;
    this.now = o.now ?? Date.now;
  }

  /** @throws OAuthFlowError (404 no connection, 503 no master key, 409 unreadable client secret) */
  start(provider: string, base: string): { url: URL; state: string } {
    const { store, requests } = this.o;
    const conn = store.get(provider);
    if (!conn) throw new OAuthFlowError(404, `no connection for ${provider}; save its client id first`);
    if (!store.secretsEnabled) throw new OAuthFlowError(503, new OAuthStoreDisabled().message);
    let clientSecret: string | undefined;
    try {
      // Only the client secret: unreadable tokens must not block the login that replaces them.
      clientSecret = store.clientSecret(provider);
    } catch (e) {
      if (e instanceof OAuthDecryptError) throw new OAuthFlowError(409, e.message);
      throw e;
    }
    const uri = redirectUri(base, provider);
    const client = this.buildClient(clientConfig(conn, clientSecret), uri);
    const scopes = requests.requestedScopes(provider, store.grants(provider), conn.extraScopes);
    const state = generateState();
    const verifier = client.pkce ? generateCodeVerifier() : undefined;
    this.sweep();
    this.pending.set(state, { provider, clientId: conn.clientId, redirectUri: uri, scopes, expiresAt: this.now() + STATE_TTL_MS, ...(verifier !== undefined && { verifier }) });
    return { url: client.authorizationUrl(state, verifier, scopes), state };
  }

  /** Handles the provider's redirect back. `cookieState` is the state the browser's cookie carries. */
  async finish(provider: string, query: URLSearchParams, cookieState: string | undefined): Promise<FinishResult> {
    const { store } = this.o;
    const name = providerName(provider);
    const state = query.get("state");
    const pending = state ? this.pending.get(state) : undefined;
    if (state) this.pending.delete(state);
    if (!state || !cookieState || state !== cookieState || !pending || pending.provider !== provider) {
      return { ok: false, error: `The ${name} login could not be verified. Click Connect again.` };
    }
    if (pending.expiresAt <= this.now()) return { ok: false, error: `The ${name} login expired. Click Connect again.` };

    const providerError = query.get("error");
    if (providerError) {
      const description = query.get("error_description");
      return { ok: false, error: `${name} did not connect: ${providerError}${description ? `: ${description}` : ""}` };
    }
    const code = query.get("code");
    if (!code) return { ok: false, error: `${name} sent no authorization code. Click Connect again.` };

    const conn = store.get(provider);
    if (!conn) return { ok: false, error: `The ${name} connection was deleted during the login.` };
    if (conn.clientId !== pending.clientId) return { ok: false, error: `The ${name} connection was changed during the login. Click Connect again.` };
    let clientSecret: string | undefined;
    try {
      clientSecret = store.clientSecret(provider);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const client = this.buildClient(clientConfig(conn, clientSecret), pending.redirectUri);
    let tokens: arctic.OAuth2Tokens;
    try {
      tokens = await client.exchange(code, pending.verifier, pending.scopes);
    } catch (e) {
      const message = e instanceof arctic.OAuth2RequestError
        ? `exchanging the authorization code was refused: ${providerMessage(e)}`
        : `exchanging the authorization code failed: ${e instanceof arctic.UnexpectedResponseError || e instanceof arctic.UnexpectedErrorResponseBodyError ? `HTTP ${e.status}` : "network error"}`;
      // A failed Reconnect leaves a working login as it was; only a connection without one shows the error.
      if (!(conn.state === "connected" && conn.hasTokens)) store.setError(provider, message);
      return { ok: false, error: `${name}: ${message}` };
    }
    // Saved with another client, or deleted, while the code was being exchanged: these tokens belong to nobody.
    if (store.get(provider)?.clientId !== pending.clientId) return { ok: false, error: `The ${name} connection was changed during the login. Click Connect again.` };
    const expiresAt = tokenExpiry(tokens, this.now());
    store.storeTokens(provider, {
      accessToken: tokens.accessToken(),
      ...(tokens.hasRefreshToken() && { refreshToken: tokens.refreshToken() }),
      ...(expiresAt && { expiresAt }),
      grantedScopes: reportedScopes(tokens) ?? pending.scopes,
    });
    return { ok: true };
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(state);
  }
}
