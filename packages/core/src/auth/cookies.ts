/**
 * Cookies for the login. On https the session cookie is `__Host-friday_session` (Secure, host-only, Path=/); over
 * plain http, which only localhost may use, it is `friday_session` without Secure. The login cookie holds the state,
 * PKCE verifier, nonce and return path for 10 minutes.
 */

export const LOGIN_COOKIE_MAX_AGE_S = 10 * 60;

const isHttps = (publicUrl: string | undefined): boolean => {
  try {
    return publicUrl ? new URL(publicUrl).protocol === "https:" : false;
  } catch {
    return false;
  }
};

export const sessionCookieName = (publicUrl: string | undefined): string => (isHttps(publicUrl) ? "__Host-friday_session" : "friday_session");
export const loginCookieName = (publicUrl: string | undefined): string => (isHttps(publicUrl) ? "__Host-friday_login" : "friday_login");

/** The value of cookie `name` in a Cookie header; undefined when absent or not decodable. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface CookieOptions {
  /** Seconds; 0 clears the cookie. Absent: a session cookie (the server ends idle sessions itself). */
  maxAge?: number;
  publicUrl: string | undefined;
}

/** A Set-Cookie value: HttpOnly, SameSite=Lax, Path=/, and Secure on https. */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (isHttps(o.publicUrl)) parts.push("Secure");
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  return parts.join("; ");
}

export const clearCookie = (name: string, publicUrl: string | undefined): string => serializeCookie(name, "", { maxAge: 0, publicUrl });
