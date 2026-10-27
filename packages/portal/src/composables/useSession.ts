/**
 * The logged-in user and the login guard, for the whole portal. Boot (main.ts) sets `me` before the shell mounts and
 * routes every `fetch` through the guard, so a 401 anywhere sends the browser to the login.
 */
import { ref } from "vue";
import { LoginGuard, logout as postLogout, type Me } from "../lib/auth.js";

export const me = ref<Me | undefined>(undefined);

export const loginGuard = new LoginGuard({
  navigate: (url) => location.assign(url),
  here: () => `${location.pathname}${location.search}${location.hash}`,
});

/** Set after logging out: the portal shows its logged-out page, with the provider's end-session link when given. */
export const loggedOut = ref<{ endSessionUrl: string | null } | null>(null);

export async function logout(): Promise<void> {
  loginGuard.stop();
  const endSessionUrl = await postLogout(fetch);
  me.value = undefined;
  loggedOut.value = { endSessionUrl };
}

export const useSession = () => ({ me, loggedOut, logout, hold: () => loginGuard.hold() });
