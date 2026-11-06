/** The part of `navigator` registering the service worker needs. */
export interface WorkerNavigator {
  serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
}

/**
 * Register public/sw.js, which shows an offline page when the server can't be reached (see the file). Only when
 * `enabled` (builds for deployment, not the dev server) and the browser has service workers. A failure is logged and
 * otherwise ignored: the portal works the same without it.
 */
export async function registerServiceWorker(nav: WorkerNavigator, enabled: boolean, log: Pick<Console, "warn"> = console): Promise<boolean> {
  if (!enabled || !nav.serviceWorker) return false;
  try {
    await nav.serviceWorker.register("/sw.js", { scope: "/" });
    return true;
  } catch (e) {
    log.warn("Registering the service worker failed; the offline page won't be shown.", e);
    return false;
  }
}
