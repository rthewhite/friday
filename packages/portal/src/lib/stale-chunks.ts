/**
 * A tab left open across a deploy still runs the old bundle; its next lazy page asks for a content-hashed chunk the
 * deploy removed, and the import fails. The router reloads at the target page once (see router.ts); these helpers
 * recognise that failure and keep a really broken chunk from reloading in a loop.
 */

/** sessionStorage key holding the time of the last such reload, per tab. */
export const RELOAD_KEY = "friday:chunk-reload";
export const RELOAD_GUARD_MS = 10_000;

// Chrome, Safari and Firefox word a failed dynamic import differently.
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_ERROR.test(error.message);
}

/** True when no such reload happened in the last RELOAD_GUARD_MS (or the stored time is unreadable). */
export function shouldReload(now: number, lastReloadAt: string | null): boolean {
  const last = lastReloadAt === null ? NaN : Number(lastReloadAt);
  return !Number.isFinite(last) || now - last >= RELOAD_GUARD_MS;
}
