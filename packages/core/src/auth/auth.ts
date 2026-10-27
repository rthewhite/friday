/**
 * Who is making a request. With OIDC configured: the session cookie, its user, and a claim refresh once a day
 * (a refusal or a lost group ends the session; an unreachable provider keeps it). Without auth configured: the dev
 * user for the local machine and nobody else. The result is remembered per request, so routes read it with
 * `requestUser(req)`.
 */
import type { IncomingMessage } from "node:http";
import { isLocalHostHeader, isLoopback, type AuthMode, type OidcSettings } from "./config.js";
import { readCookie, sessionCookieName } from "./cookies.js";
import type { SessionStore } from "./sessions.js";
import type { Role, User, UserStore } from "./users.js";

/** Claims about a person, as read from an ID token or the userinfo endpoint. */
export interface IdentityClaims {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
  groups: string[];
}

export type RefreshOutcome =
  | { ok: true; claims: IdentityClaims; refreshToken?: string }
  /**
   * `refused`: the provider said no (revoked, deactivated). `unreachable`: try again later; `refreshToken` is set when
   * the token endpoint already rotated it before a later step (userinfo) failed, and must be kept.
   */
  | { ok: false; reason: "refused" | "unreachable"; error?: string; refreshToken?: string };

/** The part of the OIDC client the session check needs. */
export interface ClaimsRefresher {
  refresh(refreshToken: string, subject: string): Promise<RefreshOutcome>;
}

export interface Authenticated {
  user: User;
  /** The session's id; absent for the dev user. */
  sessionId?: string;
}

/** The role the groups give, or undefined when they give no access to Friday. */
export function roleFromGroups(groups: readonly string[], s: Pick<OidcSettings, "userGroup" | "adminGroup">): Role | undefined {
  if (groups.includes(s.adminGroup)) return "admin";
  if (groups.includes(s.userGroup)) return "member";
  return undefined;
}

const known = new WeakMap<IncomingMessage, Authenticated>();

/** After an unreachable provider, a session's requests don't wait for a refresh again for this long. */
export const REFRESH_RETRY_MS = 5 * 60 * 1000;

/** The user `Auth.authenticate` found for this request; undefined before it ran or when there is none. */
export const requestUser = (req: IncomingMessage): User | undefined => known.get(req)?.user;
export const requestAuth = (req: IncomingMessage): Authenticated | undefined => known.get(req);

export interface AuthOptions {
  mode: AuthMode;
  users: UserStore;
  sessions?: SessionStore;
  oidc?: ClaimsRefresher;
  /** Core's resolved FRIDAY_PUBLIC_URL, for the cookie name. */
  publicUrl: () => string | undefined;
  log?: Pick<Console, "log" | "warn">;
  now?: () => Date;
}

export class Auth {
  private readonly log: Pick<Console, "log" | "warn">;
  /**
   * Claim refreshes in flight, by session: the portal sends several requests at once, and a provider that rotates
   * refresh tokens refuses the second use of the same one, which would end the session.
   */
  private readonly refreshing = new Map<string, Promise<User | "ended" | undefined>>();
  /** Sessions whose provider was unreachable, with the time to try again: until then requests don't wait for it. */
  private readonly retryAt = new Map<string, number>();

  constructor(private readonly opts: AuthOptions) {
    this.log = opts.log ?? console;
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /** True when users log in through the provider; false in dev mode. */
  get enabled(): boolean {
    return this.opts.mode.kind === "oidc";
  }

  get settings(): OidcSettings | undefined {
    return this.opts.mode.kind === "oidc" ? this.opts.mode.oidc : undefined;
  }

  /** The session cookie's name for the current public URL. */
  cookieName(): string {
    return sessionCookieName(this.opts.publicUrl());
  }

  /** Who made `req`, remembered for `requestUser`. Undefined when nobody: answer 401. */
  async authenticate(req: IncomingMessage): Promise<Authenticated | undefined> {
    const cached = known.get(req);
    if (cached) return cached;
    const found = this.opts.mode.kind === "dev" ? this.devUser(req) : await this.fromSession(req, this.opts.mode.oidc);
    if (found) known.set(req, found);
    return found;
  }

  private devUser(req: IncomingMessage): Authenticated | undefined {
    // From this machine, and addressed to it: a proxy or rebinding page on the same machine names another host.
    return isLoopback(req.socket?.remoteAddress) && isLocalHostHeader(req.headers.host) ? { user: this.opts.users.devUser() } : undefined;
  }

  private async fromSession(req: IncomingMessage, settings: OidcSettings): Promise<Authenticated | undefined> {
    const { sessions, users } = this.opts;
    if (!sessions) return undefined;
    const session = sessions.resolve(readCookie(req.headers.cookie, this.cookieName()));
    if (!session) return undefined;
    let user = users.get(session.userId);
    if (!user || user.disabled) {
      sessions.end(session.id);
      return undefined;
    }
    if (session.refreshDue && (this.retryAt.get(session.id) ?? 0) <= this.now()) {
      let pending = this.refreshing.get(session.id);
      if (!pending) {
        pending = this.refreshClaims(session.id, user, settings).finally(() => this.refreshing.delete(session.id));
        this.refreshing.set(session.id, pending);
      }
      const refreshed = await pending;
      if (refreshed === "ended") return undefined;
      if (refreshed) user = refreshed;
    }
    return { user, sessionId: session.id };
  }

  /** Refresh the claims of a session that is a day past its last refresh: the updated user, "ended", or undefined to keep it. */
  private async refreshClaims(sessionId: string, user: User, settings: OidcSettings): Promise<User | "ended" | undefined> {
    const { sessions, users, oidc } = this.opts;
    const refreshToken = sessions!.refreshToken(sessionId);
    const subject = users.identity(user.id)?.subject;
    if (!refreshToken || !oidc || !subject) {
      sessions!.end(sessionId);
      this.log.log(`auth: session of ${user.id} ended: its claims can't be refreshed`);
      return "ended";
    }
    const outcome = await oidc.refresh(refreshToken, subject);
    if (!outcome.ok) {
      if (outcome.reason === "unreachable") {
        this.retryAt.set(sessionId, this.now() + REFRESH_RETRY_MS);
        if (outcome.refreshToken) sessions!.replaceRefreshToken(sessionId, outcome.refreshToken);
        this.log.warn(`auth: could not refresh the claims of ${user.id}, keeping the session and trying again in ${REFRESH_RETRY_MS / 60_000} minutes: ${outcome.error ?? "provider unreachable"}`);
        return undefined;
      }
      this.retryAt.delete(sessionId);
      sessions!.end(sessionId);
      this.log.log(`auth: session of ${user.id} ended: the provider refused the refresh${outcome.error ? ` (${outcome.error})` : ""}`);
      return "ended";
    }
    const role = roleFromGroups(outcome.claims.groups, settings);
    if (!role) {
      sessions!.end(sessionId);
      this.log.log(`auth: session of ${user.id} ended: no longer in a Friday group`);
      return "ended";
    }
    const updated = users.refresh(user.id, { email: outcome.claims.email, name: outcome.claims.name, preferredUsername: outcome.claims.preferredUsername, role });
    sessions!.markRefreshed(sessionId, outcome.refreshToken);
    return updated;
  }
}
