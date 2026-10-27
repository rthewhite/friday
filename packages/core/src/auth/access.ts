/**
 * Which API paths need what. Every `/api` request needs a user; the household's setup (configuration and secrets,
 * MCP servers, keys, devices, OAuth connections, jobs, alerts, users, module reload) needs an admin. Paths are judged
 * by their non-empty segments, exactly as the route table matches them, so `/api//config` is still `/api/config`.
 */

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
