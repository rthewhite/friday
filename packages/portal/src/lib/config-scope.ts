/** What the drawer needs to know about a key to pick and save its scopes. */
export interface ScopeEntry {
  /** The scope the listing shows for the key (where the winning stored value is), if any. */
  scope?: string;
  /** Requesters of the key: modules and `core`. */
  modules: { id: string }[];
  /** Secret values are never listed, so their copies can't be compared. */
  secret?: boolean;
  /** The value the drawer shows (plain entries): the one stored in `scope`. */
  value?: string;
  /** Every scope the key is stored in, global first, with its value for plain entries. */
  stored?: { scope: string; value?: string }[];
}

/** One PUT the drawer sends: the typed value, or a server-side copy from another scope. */
export type ScopeWrite = { scope: string; value: string } | { scope: string; from: string };

/**
 * The scope for a key with nothing stored (or the scope its value is stored in): the only requester when
 * exactly one declares it, otherwise global, so a key several requesters share
 * (FRIDAY_TIMEZONE: core, builtin, brain, travel) is saved for all of them by default.
 */
export function defaultScope(entry: { scope?: string; modules: { id: string }[] }): string {
  if (entry.scope) return entry.scope;
  return entry.modules.length === 1 ? entry.modules[0]!.id : "global";
}

/**
 * The scopes the drawer preselects: every requester holding a copy, so re-saving updates them all; else global
 * when a global copy exists; else the nothing-stored rule. For a plain value only the copies holding the value
 * the field shows count, so saving never overwrites a different (override) value unasked. A leftover scope
 * (not a requester) is never preselected.
 */
export function defaultScopes(entry: ScopeEntry): string[] {
  const stored = new Map((entry.stored ?? []).map((s) => [s.scope, s.value]));
  const same = (scope: string) => entry.secret || entry.value === undefined || stored.get(scope) === entry.value;
  const own = entry.modules.map((m) => m.id).filter((id) => stored.has(id) && same(id));
  if (own.length) return own;
  if (stored.has("global")) return ["global"];
  return [defaultScope({ modules: entry.modules })];
}

/** Toggle one scope; global and the requesters exclude each other. The result follows the order of `options`. */
export function toggleScope(options: string[], selected: string[], scope: string): string[] {
  const next = new Set(selected);
  if (next.has(scope)) next.delete(scope);
  else if (scope === "global") return ["global"];
  else {
    next.delete("global");
    next.add(scope);
  }
  return options.filter((o) => next.has(o));
}

/**
 * The writes `Save` sends, or null when there is nothing to save. With a value, every selected scope gets it.
 * With an empty value, each selected scope without a copy gets a copy of the stored value from `source`: the
 * first selected scope holding one, else the entry's scope, else the first stored scope.
 */
export function savePlan(entry: ScopeEntry | null, selected: string[], value: string): { writes: ScopeWrite[]; source?: string } | null {
  if (!selected.length) return null;
  if (value) return { writes: selected.map((scope) => ({ scope, value })) };
  const stored = (entry?.stored ?? []).map((s) => s.scope);
  const targets = selected.filter((s) => !stored.includes(s));
  const source = selected.find((s) => stored.includes(s)) ?? (entry?.scope && stored.includes(entry.scope) ? entry.scope : stored[0]);
  if (!source || !targets.length) return null;
  return { writes: targets.map((scope) => ({ scope, from: source })), source };
}
