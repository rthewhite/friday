/**
 * A tab left open across a deploy still runs the old bundle; its next lazy page asks for content-hashed files the
 * deploy removed, and the import fails. The router (see router.ts) reloads at the target page once; these helpers
 * recognise that failure, make the reload, and keep a really broken page from reloading in a loop: a target is
 * reloaded for at most once until some navigation succeeds again.
 */

/** sessionStorage key holding the target the last such reload went to, per tab. */
export const RELOAD_KEY = "friday:chunk-reload";

// Chrome, Safari and Firefox word a failed dynamic import differently; Vite's own preload throws for a missing CSS file.
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS for/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

/** The browser objects the handler needs; injectable for tests. */
export interface ReloadEnv {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  location: { href: string; assign(url: string): void; reload(): void };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  log(error: unknown): void;
}

/**
 * The router's error handler. A failed page import reloads at `to` unless this tab already reloaded for that target
 * without a successful navigation since. Everything else, and everything it cannot safely reload for, is logged:
 * with a handler registered the router no longer logs errors itself.
 */
export function handleNavigationError(error: unknown, to: string, env: ReloadEnv): "reloaded" | "logged" {
  const logged = () => { env.log(error); return "logged" as const; };
  if (!isChunkLoadError(error)) return logged();
  try {
    if (env.storage.getItem(RELOAD_KEY) === to) return logged();
    env.storage.setItem(RELOAD_KEY, to);
  } catch {
    // Storage blocked: without the mark a broken page could reload forever, so don't reload.
    return logged();
  }
  const target = new URL(to, env.location.href);
  const here = new URL(env.location.href);
  if (target.pathname + target.search === here.pathname + here.search) {
    // assign() would only move to the fragment; put the target in the address bar and reload the document.
    if (target.hash !== here.hash) env.history.replaceState(null, "", target.href);
    env.location.reload();
  } else {
    env.location.assign(target.href);
  }
  return "reloaded";
}

/** After a successful navigation: a later deploy may need a reload for the same page again. */
export function clearReloadMark(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(RELOAD_KEY);
  } catch {
    // storage blocked; nothing was stored either
  }
}
