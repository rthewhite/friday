/**
 * Which API paths need what. Every `/api` request needs a user; the household's setup (configuration and secrets,
 * MCP servers, keys, devices, OAuth connections, jobs, alerts, users, module reload) needs an admin. Paths are judged
 * by their non-empty segments, exactly as the route table matches them, so `/api//config` is still `/api/config`.
 */

import type { IncomingHttpHeaders } from "node:http";

/** Second segments under `/api/` that only admins may use, with everything below them. */
const ADMIN_AREAS = new Set(["config", "mcp", "keys", "devices", "oauth", "jobs", "alerts", "users"]);

const segments = (pathname: string) => pathname.split("/").filter(Boolean);

/** True for `/api` and everything under it. */
export const isApiPath = (pathname: string): boolean => segments(pathname)[0] === "api";

/** True when only an admin may make this request. */
export function adminOnly(method: string, pathname: string): boolean {
  const s = segments(pathname);
  if (s[0] !== "api") return false;
  if (ADMIN_AREAS.has(s[1] ?? "")) return true;
  return method === "POST" && s[1] === "modules" && s.length === 4 && s[3] === "reload";
}

/**
 * True when a browser sent this request from another origin: a `Sec-Fetch-Site` other than `same-origin` or `none`,
 * or an `Origin` whose host differs from `Host` (or an opaque one). The session cookie is SameSite=Lax, so it still
 * comes along from another *.thewhite.nl host, which counts as the same site. Without this, a page there could change
 * Friday through the API (a CORS "simple request" needs no preflight) or open a Talk session as the user. Non-browser
 * clients send neither header and pass.
 */
export function isCrossOrigin(req: { headers: IncomingHttpHeaders }): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // "null" and other opaque origins
  }
}
