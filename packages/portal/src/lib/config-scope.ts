/**
 * The scope the configuration drawer preselects for a key: where its value is stored; for an unstored key
 * the only requester when exactly one declares it, otherwise global, so a key several requesters share
 * (FRIDAY_TIMEZONE: core, builtin, brain, travel) is saved for all of them by default.
 */
export function defaultScope(entry: { scope?: string; modules: { id: string }[] }): string {
  if (entry.scope) return entry.scope;
  return entry.modules.length === 1 ? entry.modules[0]!.id : "global";
}
