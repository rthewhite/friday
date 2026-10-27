/**
 * Access tokens for modules: the only way a token leaves core. Checks the module's request and grant and the
 * connection on every call, refreshes a token that expires within a minute (one refresh per connection, shared by
 * concurrent callers), and turns every failure into an OAuthError whose message tells the user what to do.
 */
import * as arctic from "arctic";
import { OAuthError, type ModuleOAuth } from "@friday/sdk";
import { buildClient as defaultBuildClient, clientConfig, providerName, type BuildClient, type OAuthClient } from "./catalogue.js";
import type { OAuthRequests, RequestSet } from "./requests.js";
import { OAuthDecryptError, type OAuthStore, type StoredConnection } from "./store.js";

/** A token expiring sooner than this is refreshed first. */
export const REFRESH_MARGIN_MS = 60_000;

/**
 * What `refreshNow` did: `error` left the connection in state `error` (refused, or unreadable), `retry` left it
 * `connected` (network failure or provider server error), `changed` discarded a refresh for a client that was replaced.
 */
export type RefreshOutcome =
  | { result: "refreshed" }
  | { result: "skipped"; reason: string }
  | { result: "error"; message: string }
  | { result: "retry"; message: string }
  | { result: "changed" };

const WHERE = "under Settings > Connections";

/** When a token response's access token expires, on Friday's clock; undefined when the provider gave no expiry. */
export function tokenExpiry(tokens: arctic.OAuth2Tokens, now: number): Date | undefined {
  try {
    return new Date(now + tokens.accessTokenExpiresInSeconds() * 1000);
  } catch {
    return undefined;
  }
}

/** The scopes a token response reports as granted, if it reports any. */
export const reportedScopes = (tokens: arctic.OAuth2Tokens): string[] | undefined =>
  tokens.hasScopes() ? tokens.scopes().filter(Boolean) : undefined;

/** The provider's own words for an OAuth error response, e.g. `invalid_grant: Refresh token revoked`. */
export const providerMessage = (e: arctic.OAuth2RequestError): string => (e.description ? `${e.code}: ${e.description}` : e.code);

/** The connection's error after the provider refused a refresh. */
const refusedMessage = (e: arctic.OAuth2RequestError): string => `refreshing the login was refused: ${providerMessage(e)}`;

export interface OAuthTokensOptions {
  store: OAuthStore;
  requests: OAuthRequests;
  /** Redirect URI a client is built with; refreshes don't send it, but Arctic's constructors want one. */
  redirectUri: (provider: string) => string;
  buildClient?: BuildClient;
  now?: () => number;
  log?: Pick<Console, "warn">;
}

export class OAuthTokens {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly buildClient: BuildClient;
  private readonly now: () => number;
  private readonly log: Pick<Console, "warn">;

  constructor(private readonly o: OAuthTokensOptions) {
    this.buildClient = o.buildClient ?? defaultBuildClient;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? console;
  }

  /** `ctx.oauth` for one module. */
  forModule(moduleId: string): ModuleOAuth {
    return { token: (provider) => this.token(provider, moduleId) };
  }

  async token(provider: string, moduleId: string): Promise<string> {
    const { store } = this.o;
    const requests = this.o.requests.snapshot();
    const name = providerName(provider);
    if (!requests.forModule(provider, moduleId)) {
      throw new OAuthError("not_granted", `${moduleId} does not request access to ${name}; its manifest must list ${provider} under oauth`);
    }
    const conn = store.get(provider);
    if (!conn) throw new OAuthError("not_connected", `${name} is not connected yet. Connect it ${WHERE}.`);
    if (!store.hasGrant(provider, moduleId)) {
      throw new OAuthError("not_granted", `${name} access is not granted to ${moduleId} yet. Grant it ${WHERE}.`);
    }
    if (!store.secretsEnabled) {
      throw new OAuthError("not_connected", `${name} can't be used because FRIDAY_MASTER_KEY is not set; connections need it.`);
    }
    if (conn.state === "error") throw needsReconnect(name, conn.error);
    if (conn.state !== "connected") throw new OAuthError("not_connected", `${name} is not connected yet. Connect it ${WHERE}.`);

    const secrets = this.secrets(provider, name);
    if (!secrets.accessToken) throw new OAuthError("not_connected", `${name} is not connected yet. Connect it ${WHERE}.`);
    if (!expiresSoon(conn, this.now())) return secrets.accessToken;
    return this.sharedRefresh(conn, name, secrets.refreshToken, () => this.moduleScopes(conn, requests), () => this.client(conn, secrets.clientSecret));
  }

  /**
   * Refreshes a connection now, on behalf of no module: the nightly keep-alive. Shares an in-flight refresh with
   * `token()` and follows its rules, but reports the outcome instead of throwing, and skips a connection it cannot
   * refresh without putting it in `error` (that still happens when its token expires and a module asks for it).
   * It asks for the scopes the stored token was granted, so keeping a login alive never narrows it, even when no
   * module holds a grant; providers that don't report scopes get the scopes a module's refresh would ask for.
   */
  async refreshNow(provider: string): Promise<RefreshOutcome> {
    const { store } = this.o;
    if (!store.secretsEnabled) return { result: "skipped", reason: "FRIDAY_MASTER_KEY is not set" };
    const conn = store.get(provider);
    if (conn?.state !== "connected" || !conn.hasTokens) return { result: "skipped", reason: "not connected" };
    try {
      const secrets = store.secrets(provider);
      const client = this.client(conn, secrets.clientSecret);
      if (!client.refresh) return { result: "skipped", reason: "does not refresh logins" };
      if (!secrets.refreshToken) return { result: "skipped", reason: "no refresh token was stored" };
      const scopes = () => (conn.grantedScopes?.length ? conn.grantedScopes : this.moduleScopes(conn, this.o.requests.snapshot()));
      await this.sharedRefresh(conn, providerName(provider), secrets.refreshToken, scopes, () => client);
      return { result: "refreshed" };
    } catch (e) {
      if (e instanceof OAuthDecryptError) return { result: "error", message: e.message };
      if (!(e instanceof OAuthError)) {
        // A provider answer without a token, a client that can't be built, a database error: this login only.
        return { result: "retry", message: e instanceof Error ? e.message : "unknown error" };
      }
      if (e.kind === "not_connected") return { result: "changed" };
      if (e.cause instanceof arctic.OAuth2RequestError) return { result: "error", message: refusedMessage(e.cause) };
      return { result: "retry", message: errorSummary(e.cause) };
    }
  }

  /** The scopes a refresh for a module asks for: the granted modules' scopes plus the extras. */
  private moduleScopes(conn: StoredConnection, requests: RequestSet): string[] {
    return requests.requestedScopes(conn.provider, this.o.store.grants(conn.provider), conn.extraScopes);
  }

  private client(conn: StoredConnection, clientSecret: string | undefined): OAuthClient {
    return this.buildClient(clientConfig(conn, clientSecret), this.o.redirectUri(conn.provider));
  }

  /** One refresh per connection at a time: a caller arriving while one is out gets its outcome. */
  private sharedRefresh(conn: StoredConnection, name: string, refreshToken: string | undefined, scopes: () => string[], client: () => OAuthClient): Promise<string> {
    const provider = conn.provider;
    let refresh = this.inflight.get(provider);
    if (!refresh) {
      refresh = this.refresh(conn, name, client, refreshToken, scopes).finally(() => this.inflight.delete(provider));
      this.inflight.set(provider, refresh);
    }
    return refresh;
  }

  private secrets(provider: string, name: string) {
    try {
      return this.o.store.secrets(provider);
    } catch (e) {
      if (e instanceof OAuthDecryptError) throw needsReconnect(name, e.message);
      throw e;
    }
  }

  private async refresh(conn: StoredConnection, name: string, buildClient: () => OAuthClient, refreshToken: string | undefined, scopes: () => string[]): Promise<string> {
    const { store } = this.o;
    const provider = conn.provider;
    const client = buildClient();
    if (!client.refresh || !refreshToken) {
      const message = client.refresh ? "the login expired and no refresh token was stored" : `the login expired and ${name} does not refresh logins`;
      store.setError(provider, message);
      throw needsReconnect(name, message);
    }
    // Saved with another client (tokens cleared) or deleted while the refresh was out: its outcome belongs to nobody.
    const changed = () => store.get(provider)?.clientId !== conn.clientId || !store.hasTokens(provider);
    const changedError = () => new OAuthError("not_connected", `${name} was changed while its login was being refreshed. Connect it ${WHERE}.`);
    let tokens: arctic.OAuth2Tokens;
    try {
      tokens = await client.refreshToken(refreshToken, scopes());
    } catch (e) {
      if (changed()) throw changedError();
      if (e instanceof arctic.OAuth2RequestError) {
        const message = refusedMessage(e);
        store.setError(provider, message);
        throw needsReconnect(name, message, e);
      }
      // Network failure or a provider server error: transient, the connection stays as it is.
      this.log.warn(`oauth: ${provider}: refresh failed: ${errorSummary(e)}`);
      throw new OAuthError("refresh_failed", `${name} could not be reached to refresh the login (${errorSummary(e)}). Try again in a moment.`, { cause: e });
    }
    if (changed()) throw changedError();
    const accessToken = tokens.accessToken();
    const expiresAt = tokenExpiry(tokens, this.now());
    const grantedScopes = reportedScopes(tokens);
    store.storeTokens(provider, {
      accessToken,
      ...(tokens.hasRefreshToken() && { refreshToken: tokens.refreshToken() }),
      ...(expiresAt && { expiresAt }),
      ...(grantedScopes && { grantedScopes }),
    });
    return accessToken;
  }
}

/** True when the token expires within the margin. A token without an expiry is used until the provider rejects it. */
const expiresSoon = (conn: StoredConnection, now: number): boolean =>
  conn.expiresAt !== undefined && Date.parse(conn.expiresAt) - REFRESH_MARGIN_MS <= now;

const needsReconnect = (name: string, reason: string | undefined, cause?: unknown): OAuthError =>
  new OAuthError("refresh_failed", `${name} needs to be reconnected ${WHERE}${reason ? `: ${reason}` : "."}`, cause === undefined ? {} : { cause });

/** What went wrong, without anything from the request (no tokens, no URLs with secrets). */
function errorSummary(e: unknown): string {
  if (e instanceof arctic.UnexpectedResponseError || e instanceof arctic.UnexpectedErrorResponseBodyError) return `HTTP ${e.status}`;
  if (e instanceof arctic.ArcticFetchError) return "network error";
  return e instanceof Error ? e.name : "unknown error";
}
