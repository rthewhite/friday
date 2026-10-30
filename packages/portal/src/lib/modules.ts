/** How the Modules page shows an `/api/modules` entry: its status dot, its kind, and whether it can be reloaded or switched off. */
import type { ApiModule } from "../composables/useModules.js";

type Entry = Pick<ApiModule, "id" | "status">;

/** Core's own entry: the tools built into Friday. Modules can't use this id. */
const CORE_ID = "core";

export type ModuleKind = "core" | "MCP server" | "remote" | "in-process";

export const moduleTone = (s: ApiModule["status"]): "success" | "error" | "neutral" =>
  s === "loaded" || s === "connected" ? "success" : s === "failed" ? "error" : "neutral";

export function moduleKind(m: Entry): ModuleKind {
  if (m.id === CORE_ID) return "core";
  if (m.id.startsWith("mcp:")) return "MCP server";
  return m.status === "connected" ? "remote" : "in-process";
}

/**
 * The module's page (`/m/<id>`) can be shown: it is loaded, ships a UI, and the user may use it. Core's own entry has
 * no UI.
 */
export const hasPage = (m: Pick<ApiModule, "status" | "ui" | "available">): boolean => m.status === "loaded" && m.ui === true && m.available !== false;

export type GateReason = "unknown" | "no_access" | "disabled" | "failed" | "no_page" | "not_enabled";

/**
 * Why `/m/<id>` shows no page. Members aren't sent the modules they may not use, so a module whose UI the portal
 * ships but which isn't listed is one the user has no access to.
 */
export function gateReason(entry: Pick<ApiModule, "status" | "ui" | "available"> | undefined, shipsUi: boolean): GateReason {
  if (!entry) return shipsUi ? "no_access" : "unknown";
  if (entry.status === "disabled") return "disabled";
  if (entry.status === "failed") return "failed";
  if (entry.available === false) return "no_access";
  return entry.ui ? "not_enabled" : "no_page";
}

/** Only in-process modules that are loaded or failed reload; core, MCP servers, remotes and disabled modules don't. */
export const isReloadable = (m: Entry): boolean => moduleKind(m) === "in-process" && m.status !== "disabled";

/** Only in-process modules can be switched on or off; core, MCP servers (their own flag) and remotes can't. */
export const isToggleable = (m: Entry): boolean => moduleKind(m) === "in-process";

/** The switch is on unless the module is disabled. */
export const isSwitchedOn = (m: Pick<ApiModule, "status">): boolean => m.status !== "disabled";

/** The list with one entry replaced by the server's new version of it (same id); other entries are unchanged. */
export const withEntry = (list: readonly ApiModule[], entry: ApiModule): ApiModule[] => list.map((m) => (m.id === entry.id ? entry : m));
