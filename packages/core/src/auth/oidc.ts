/**
 * Friday as an OpenID Connect client of the household's provider (Authentik): discovery from the issuer, the
 * authorization-code flow with PKCE (S256), state and nonce, and claim refreshes with the refresh token. The ID token
 * comes straight from the token endpoint over TLS, so its claims are checked (iss, aud, exp, nonce) without verifying
 * its signature, as OIDC Core 3.1.3.7 allows. Groups missing from the ID token are read from the userinfo endpoint.
 */
import {
  ArcticFetchError,
  CodeChallengeMethod,
  decodeIdToken,
  generateCodeVerifier,
  generateState,
  OAuth2Client,
  OAuth2RequestError,
  UnexpectedErrorResponseBodyError,
  UnexpectedResponseError,
  type OAuth2Tokens,
} from "arctic";
import type { OidcSettings } from "./config.js";
import type { ClaimsRefresher, IdentityClaims, RefreshOutcome } from "./auth.js";

export const LOGIN_SCOPES = ["openid", "email", "profile", "offline_access"];
/** Seconds of clock difference tolerated on `exp`. */
const CLOCK_SKEW_S = 60;

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

/** The login failed; `message` is safe to show on the error page. */
export class LoginError extends Error {}

export interface LoginStart {
  url: URL;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface LoginResult {
  claims: IdentityClaims;
  refreshToken?: string;
}

const stripSlash = (s: string) => s.replace(/\/+$/, "");
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export class OidcClient implements ClaimsRefresher {
  private discovered?: Promise<Discovery>;

  constructor(
    private readonly settings: OidcSettings,
    /** The redirect URI, built from FRIDAY_PUBLIC_URL at each use. */
    private readonly redirectUri: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Where to send the browser to log in, with the values the callback must check. */
  async start(): Promise<LoginStart> {
    const d = await this.discovery();
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const nonce = generateState();
    const url = this.client().createAuthorizationURLWithPKCE(d.authorization_endpoint, state, CodeChallengeMethod.S256, codeVerifier, LOGIN_SCOPES);
    url.searchParams.set("nonce", nonce);
    return { url, state, codeVerifier, nonce };
  }

  /** Exchange the code and check the ID token; throws `LoginError`. */
  async finish(code: string, codeVerifier: string, nonce: string): Promise<LoginResult> {
    const d = await this.discovery().catch((e) => {
      throw new LoginError(`the login provider can't be reached (${e instanceof Error ? e.message : e})`);
    });
    let tokens: OAuth2Tokens;
    try {
      tokens = await this.client().validateAuthorizationCode(d.token_endpoint, code, codeVerifier);
    } catch (e) {
      throw new LoginError(`the login provider refused the login (${describe(e)})`);
    }
    const claims = await this.claims(tokens, d, { nonce });
    return { claims, refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined };
  }

  async refresh(refreshToken: string, subject: string): Promise<RefreshOutcome> {
    let d: Discovery;
    try {
      d = await this.discovery();
    } catch (e) {
      return { ok: false, reason: "unreachable", error: describe(e) };
    }
    let tokens: OAuth2Tokens;
    try {
      tokens = await this.client().refreshAccessToken(d.token_endpoint, refreshToken, []);
    } catch (e) {
      return { ok: false, reason: unreachable(e) ? "unreachable" : "refused", error: describe(e) };
    }
    try {
      const claims = await this.claims(tokens, d, { subject });
      return { ok: true, claims, refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined };
    } catch (e) {
      return { ok: false, reason: "refused", error: describe(e) };
    }
  }

  /** The provider's end-session URL, when it advertises one. */
  async endSessionUrl(): Promise<string | undefined> {
    try {
      return (await this.discovery()).end_session_endpoint;
    } catch {
      return undefined;
    }
  }

  private client(): OAuth2Client {
    return new OAuth2Client(this.settings.clientId, this.settings.clientSecret, this.redirectUri());
  }

  /** The discovery document, fetched once; a failure is not cached. */
  private discovery(): Promise<Discovery> {
    this.discovered ??= (async () => {
      const url = `${stripSlash(this.settings.issuer)}/.well-known/openid-configuration`;
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`discovery at ${url} answered ${res.status}`);
      const doc = (await res.json()) as Partial<Discovery> & { issuer?: string };
      if (!str(doc.authorization_endpoint) || !str(doc.token_endpoint)) throw new Error(`discovery at ${url} has no authorization or token endpoint`);
      if (doc.issuer && stripSlash(doc.issuer) !== stripSlash(this.settings.issuer)) throw new Error(`discovery issuer ${doc.issuer} differs from ${this.settings.issuer}`);
      return doc as Discovery;
    })();
    this.discovered.catch(() => (this.discovered = undefined));
    return this.discovered;
  }

  /** Check the ID token and read the claims; groups come from userinfo when the token has none. */
  private async claims(tokens: OAuth2Tokens, d: Discovery, expect: { nonce?: string; subject?: string }): Promise<IdentityClaims> {
    let id: Record<string, unknown> | undefined;
    if ("id_token" in tokens.data) {
      try {
        id = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
      } catch {
        throw new LoginError("the ID token can't be read");
      }
      if (stripSlash(String(id.iss ?? "")) !== stripSlash(this.settings.issuer)) throw new LoginError("the ID token is from another issuer");
      const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
      if (!aud.includes(this.settings.clientId)) throw new LoginError("the ID token is for another client");
      if (typeof id.exp !== "number" || id.exp + CLOCK_SKEW_S < this.now().getTime() / 1000) throw new LoginError("the ID token has expired");
      if (expect.nonce !== undefined && id.nonce !== expect.nonce) throw new LoginError("the ID token doesn't belong to this login");
    } else if (expect.nonce !== undefined) {
      throw new LoginError("the login provider sent no ID token");
    }
    let claims: Record<string, unknown> = id ?? {};
    if ((!id || !Array.isArray(id.groups)) && d.userinfo_endpoint) {
      const info = await this.userinfo(d.userinfo_endpoint, tokens.accessToken());
      if (id && info.sub !== id.sub) throw new LoginError("userinfo is about another person");
      claims = { ...info, ...claims, groups: info.groups };
    }
    const subject = str(claims.sub);
    if (!subject) throw new LoginError("the login provider sent no subject");
    if (expect.subject !== undefined && subject !== expect.subject) throw new LoginError("the refreshed claims are about another person");
    return {
      issuer: this.settings.issuer,
      subject,
      email: str(claims.email),
      name: str(claims.name),
      preferredUsername: str(claims.preferred_username),
      groups: Array.isArray(claims.groups) ? claims.groups.filter((g): g is string => typeof g === "string") : [],
    };
  }

  private async userinfo(endpoint: string, accessToken: string): Promise<Record<string, unknown>> {
    const res = await fetch(endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new LoginError(`userinfo answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** A network failure or a server error: the provider may answer later. */
function unreachable(e: unknown): boolean {
  if (e instanceof ArcticFetchError) return true;
  if (e instanceof UnexpectedResponseError || e instanceof UnexpectedErrorResponseBodyError) return e.status >= 500;
  return false;
}

function describe(e: unknown): string {
  if (e instanceof OAuth2RequestError) return e.code + (e.description ? `: ${e.description}` : "");
  if (e instanceof UnexpectedResponseError || e instanceof UnexpectedErrorResponseBodyError) return `status ${e.status}`;
  return e instanceof Error ? e.message : String(e);
}
