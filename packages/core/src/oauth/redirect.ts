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

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || undefined;

/** The base for a request: the public URL when set, else the request's (forwarded) origin. */
export function requestBase(publicUrl: string | undefined, headers: IncomingHttpHeaders, encrypted = false): string {
  if (publicUrl?.trim()) return publicUrl.trim().replace(/\/+$/, "");
  const proto = first(headers["x-forwarded-proto"]) ?? (encrypted ? "https" : "http");
  const host = first(headers["x-forwarded-host"]) ?? first(headers.host) ?? "127.0.0.1";
  return `${proto}://${host}`;
}
