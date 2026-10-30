/**
 * Module access on the Modules page: who may use a module (everyone or chosen users) and the tools only the chosen
 * users get. The server enforces it; these helpers only describe and edit it.
 */

export type AccessMode = "everyone" | "chosen";

/** A module's access as `/api/modules` sends it to admins. `knownTools` is absent while it is the default. */
export interface ModuleAccess {
  mode: AccessMode;
  users: { id: string; name: string }[];
  restricted: string[];
  knownTools?: string[];
}

/** What the drawer edits, and `PUT /api/modules/:id/access` takes. */
export interface AccessDraft {
  mode: AccessMode;
  users: string[];
  restricted: string[];
}

/** Anchored match of a tool name against a pattern: `*` matches anything, every other character itself (as core). */
export function matchesPattern(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

/** Whether a tool is kept for the chosen users by any of the patterns. */
export const isRestricted = (tool: string, restricted: readonly string[]): boolean => restricted.some((p) => matchesPattern(p, tool));

/** A tool that wasn't there when the access was last saved; nothing is new while the access is the default. */
export const isNewTool = (tool: string, access: ModuleAccess | undefined): boolean => access?.knownTools !== undefined && !access.knownTools.includes(tool);

/** The row's note on who may use the module, or undefined for the default (everyone, nothing restricted). */
export function accessLabel(access: ModuleAccess | undefined): "Chosen users" | "Some tools restricted" | undefined {
  if (!access) return undefined;
  if (access.mode === "chosen") return "Chosen users";
  return access.restricted.length ? "Some tools restricted" : undefined;
}

/** The drawer's starting point: the stored access, without the owner (who is always included). */
export const draftOf = (access: ModuleAccess, ownerId: string | undefined): AccessDraft => ({
  mode: access.mode,
  users: access.users.map((u) => u.id).filter((id) => id !== ownerId),
  restricted: [...access.restricted],
});

/** Ticks or unticks one tool by its exact name; patterns stay as they are. */
export function toggleTool(draft: AccessDraft, tool: string, on: boolean): AccessDraft {
  const rest = draft.restricted.filter((p) => p !== tool);
  return { ...draft, restricted: on ? [...rest, tool] : rest };
}

/** The patterns that aren't one of the module's tools by name: the ones shown in the pattern list. */
export const patternsOf = (draft: AccessDraft, tools: readonly string[]): string[] => draft.restricted.filter((p) => !tools.includes(p));

/** Adds a pattern (trimmed, once); an empty one changes nothing. */
export function addPattern(draft: AccessDraft, pattern: string): AccessDraft {
  const p = pattern.trim();
  return !p || draft.restricted.includes(p) ? draft : { ...draft, restricted: [...draft.restricted, p] };
}

export const removePattern = (draft: AccessDraft, pattern: string): AccessDraft => ({ ...draft, restricted: draft.restricted.filter((p) => p !== pattern) });

/** Ticks or unticks a chosen user. */
export function toggleUser(draft: AccessDraft, id: string, on: boolean): AccessDraft {
  const rest = draft.users.filter((u) => u !== id);
  return { ...draft, users: on ? [...rest, id] : rest };
}

/**
 * The PUT body: restricted tools only matter for `everyone` (with `chosen` nobody else gets the module at all), so
 * they are dropped for `chosen`.
 */
export const accessBody = (draft: AccessDraft): AccessDraft => ({ mode: draft.mode, users: [...draft.users], restricted: draft.mode === "everyone" ? [...draft.restricted] : [] });
