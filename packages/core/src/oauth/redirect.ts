/**
 * Redirect URIs: `<base>/api/oauth/<provider>/callback`, where the base is core's FRIDAY_PUBLIC_URL or, unset, the
 * origin the request arrived at (X-Forwarded-Proto/-Host as Traefik sets them). Spoofed forwarded headers only change
 * the redirect URI of the user's own authorization request, which the provider refuses unless it is registered.
 */
import type { IncomingHttpHeaders } from "node:http";

/** Used for clients built outside a request (refreshes don't send the redirect URI). */
export const FALLBACK_BASE = "http://127.0.0.1";

export const callbackPath = (provider: string) => `/api/oauth/${encodeURIComponent(provider)}/callback`;

export const redirectUri = (base: string, provider: string): string => `${base.replace(/\/+$/, "")}${callbackPath(provider)}`;

const warned = new Set<string>();

/**
 * FRIDAY_PUBLIC_URL as a base (no trailing slash), or undefined when unset. A value that is not an absolute http(s)
 * URL is ignored, with a warning once per value, rather than producing redirect URIs no provider accepts.
 */
export function publicBase(value: string | undefined, warn: (m: string) => void = console.warn): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:") return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    // fall through
  }
  if (!warned.has(v)) {
    warned.add(v);
    warn(`oauth: FRIDAY_PUBLIC_URL ${JSON.stringify(v)} is not an absolute http(s) URL; using the request's address instead`);
  }
  return undefined;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || undefined;

/** The origin a request arrived at, from forwarded headers when a proxy set them. */
export function requestOrigin(headers: IncomingHttpHeaders, encrypted = false): string {
  const proto = first(headers["x-forwarded-proto"]) ?? (encrypted ? "https" : "http");
  const host = first(headers["x-forwarded-host"]) ?? first(headers.host) ?? "127.0.0.1";
  return `${proto}://${host}`;
}

/** The base for a request: the public URL when set and valid, else the request's (forwarded) origin. */
export function requestBase(publicUrl: string | undefined, headers: IncomingHttpHeaders, encrypted = false): string {
  return publicBase(publicUrl) ?? requestOrigin(headers, encrypted);
}
