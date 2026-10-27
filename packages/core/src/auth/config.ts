/**
 * How Friday authenticates browsers. With FRIDAY_AUTH_ISSUER set, users log in through that OpenID Connect provider
 * (Authentik). Without it, only the local machine gets in, as the dev user, and only while the public URL is a
 * localhost one: a deployment without auth refuses to start. The keys come from the environment only, never from
 * the configuration store, which sits behind the login itself.
 */
import type { Env } from "@friday/sdk";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  userGroup: string;
  adminGroup: string;
}

export type AuthMode = { kind: "oidc"; oidc: OidcSettings } | { kind: "dev" };

export const DEFAULT_USER_GROUP = "friday-users";
export const DEFAULT_ADMIN_GROUP = "friday-admins";

/** A startup problem: Friday must not run like this. */
export class AuthConfigError extends Error {}

const value = (env: Env, key: string): string | undefined => env[key]?.trim() || undefined;

/** `http://localhost` or `http://127.0.0.1`, any port and path. */
export function isLocalPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * The auth mode for this process, or an `AuthConfigError` naming what is missing. `publicUrl` is core's resolved
 * FRIDAY_PUBLIC_URL; `hasMasterKey` whether FRIDAY_MASTER_KEY is usable (refresh tokens are sealed with it).
 */
export function authMode(env: Env, publicUrl: string | undefined, hasMasterKey: boolean): AuthMode {
  const issuer = value(env, "FRIDAY_AUTH_ISSUER");
  const url = publicUrl?.trim() || undefined;
  if (!issuer) {
    if (url && !isLocalPublicUrl(url)) {
      throw new AuthConfigError(
        `authentication must be configured: FRIDAY_PUBLIC_URL is ${url}, but FRIDAY_AUTH_ISSUER is not set (only http://localhost or http://127.0.0.1 may run without auth)`,
      );
    }
    return { kind: "dev" };
  }
  for (const key of ["FRIDAY_AUTH_CLIENT_ID", "FRIDAY_AUTH_CLIENT_SECRET"]) {
    if (!value(env, key)) throw new AuthConfigError(`FRIDAY_AUTH_ISSUER is set, but ${key} is missing`);
  }
  if (!hasMasterKey) throw new AuthConfigError("FRIDAY_AUTH_ISSUER is set, but FRIDAY_MASTER_KEY is missing (sessions seal refresh tokens with it)");
  if (!url) throw new AuthConfigError("FRIDAY_AUTH_ISSUER is set, but FRIDAY_PUBLIC_URL is missing (the login redirect URI is built from it)");
  try {
    new URL(issuer);
  } catch {
    throw new AuthConfigError(`FRIDAY_AUTH_ISSUER ${JSON.stringify(issuer)} is not a URL`);
  }
  return {
    kind: "oidc",
    oidc: {
      issuer,
      clientId: value(env, "FRIDAY_AUTH_CLIENT_ID")!,
      clientSecret: value(env, "FRIDAY_AUTH_CLIENT_SECRET")!,
      userGroup: value(env, "FRIDAY_AUTH_USER_GROUP") ?? DEFAULT_USER_GROUP,
      adminGroup: value(env, "FRIDAY_AUTH_ADMIN_GROUP") ?? DEFAULT_ADMIN_GROUP,
    },
  };
}

/** `<public URL>/auth/callback`, without a doubled slash. */
export const loginRedirectUri = (publicUrl: string): string => `${publicUrl.trim().replace(/\/+$/, "")}/auth/callback`;

/**
 * A Host header naming the local machine: `localhost`, `127.0.0.1` or `[::1]`, with any port. A reverse proxy on the
 * same machine passes the public name it was reached at, and a DNS-rebinding page its own name, so neither does.
 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/**
 * A peer address of the local machine: 127.0.0.0/8, ::1, or an IPv4-mapped loopback. Only the socket's own address
 * counts; forwarded headers are never consulted.
 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}
