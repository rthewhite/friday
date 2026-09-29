/** What the configuration page needs to know about a key stored in more than one scope. */
export interface StoredEntry {
  scope?: string;
  status?: string;
  /** Requesters of the key: modules and `core`. Each reads its own scope first, then global. */
  modules?: { id: string }[];
  stored?: { scope: string }[];
}

/**
 * The scope the table shows for a key, and the other stored scopes behind `+N`. Without a winning scope
 * (for example secrets that cannot be read) the first stored scope stands in, so the cell is never a bare `+N`.
 */
export function scopeSummary(entry: StoredEntry): { scope: string; others: string[] } {
  const stored = (entry.stored ?? []).map((s) => s.scope);
  const scope = entry.scope ?? stored[0] ?? (entry.status === "env" ? "environment" : "");
  return { scope, others: stored.filter((s) => s !== scope) };
}

/** Requesters with their own stored copy: each reads that copy instead of the global value. */
export function ownCopies(entry: StoredEntry): string[] {
  const requesters = new Set((entry.modules ?? []).map((m) => m.id));
  return (entry.stored ?? []).map((s) => s.scope).filter((s) => s !== "global" && requesters.has(s));
}

/** Stored scopes that do not request the key, for example one left behind by a removed module. */
export function strayCopies(entry: StoredEntry): string[] {
  const requesters = new Set((entry.modules ?? []).map((m) => m.id));
  return (entry.stored ?? []).map((s) => s.scope).filter((s) => s !== "global" && !requesters.has(s));
}
