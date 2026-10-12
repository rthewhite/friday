/** How the Modules page shows an `/api/modules` entry: its status dot, its kind, and whether it can be reloaded. */
import type { ApiModule } from "../composables/useModules.js";

type Entry = Pick<ApiModule, "id" | "status">;

/** Core's own entry: the tools built into Friday. Modules can't use this id. */
const CORE_ID = "core";

export type ModuleKind = "built in" | "MCP server" | "remote" | "in-process";

export const moduleTone = (s: ApiModule["status"]): "success" | "error" | "neutral" =>
  s === "loaded" || s === "connected" ? "success" : s === "failed" ? "error" : "neutral";

export function moduleKind(m: Entry): ModuleKind {
  if (m.id === CORE_ID) return "built in";
  if (m.id.startsWith("mcp:")) return "MCP server";
  return m.status === "connected" ? "remote" : "in-process";
}

/** Only in-process modules that are loaded or failed reload; core, MCP servers, remotes and disabled modules don't. */
export const isReloadable = (m: Entry): boolean => moduleKind(m) === "in-process" && m.status !== "disabled";
