/** What the configuration drawer needs to know about a key stored in more than one scope. */
export interface StoredEntry {
  scope?: string;
  stored?: { scope: string }[];
}

/** How many stored scopes besides the one the entry reports, for the table's `global +1`. */
export function extraScopes(entry: StoredEntry): number {
  return (entry.stored ?? []).filter((s) => s.scope !== entry.scope).length;
}

/**
 * Module scopes that override a stored global value for their module. `core` is not a module:
 * it only affects core's own use of the key.
 */
export function overrides(entry: StoredEntry): string[] {
  const scopes = (entry.stored ?? []).map((s) => s.scope);
  if (!scopes.includes("global")) return [];
  return scopes.filter((s) => s !== "global" && s !== "core");
}
