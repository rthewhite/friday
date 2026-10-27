/**
 * The portal's side of the login. Boot loads `/api/me` before the shell renders; a 401 there or on any later API
 * call sends the browser to `/auth/login` with the current path to come back to. While a chat reply streams or the
 * Talk page is connected, that waits until they end. A login that doesn't stick (the cookie isn't kept, for example
 * because FRIDAY_PUBLIC_URL doesn't match the address opened) is reported instead of bouncing forever.
 */

export type Role = "admin" | "member";

export interface Me {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  owner: boolean;
  /** False in dev mode: the local machine is the dev user and there is no login or logout. */
  authEnabled: boolean;
}

export const loginUrl = (returnTo: string): string => `/auth/login?return_to=${encodeURIComponent(returnTo)}`;

export interface LoginGuardDeps {
  navigate: (url: string) => void;
  /** The current path, query and hash, to come back to. */
  here: () => string;
}

/** Sends the browser to the login once, when the session is gone and nothing holds it back. */
export class LoginGuard {
  private holds = 0;
  private pending = false;
  private done = false;

  constructor(private readonly deps: LoginGuardDeps) {}

  /** A request answered 401: go to the login now, or as soon as the last hold is released. */
  unauthenticated(): void {
    if (this.done) return;
    if (this.holds > 0) {
      this.pending = true;
      return;
    }
    this.go();
  }

  /** Keep the browser here (a streaming reply, a live voice session) until the returned function is called. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0 && this.pending) this.go();
    };
  }

  /** Never go to the login again (after logging out, the portal shows its own page). */
  stop(): void {
    this.done = true;
  }

  private go(): void {
    this.done = true;
    this.deps.navigate(loginUrl(this.deps.here()));
  }
}

/** A path of Friday's API on this origin. */
function isApi(input: RequestInfo | URL, origin: string): boolean {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
    return url.origin === origin && (url.pathname === "/api" || url.pathname.startsWith("/api/"));
  } catch {
    return false;
  }
}

/** `fetch` that reports a 401 from Friday's API to the guard, and otherwise behaves exactly like `original`. */
export function guardFetch(original: typeof fetch, guard: Pick<LoginGuard, "unauthenticated">, origin: string): typeof fetch {
  return async (input, init) => {
    const res = await original(input, init);
    if (res.status === 401 && isApi(input, origin)) guard.unauthenticated();
    return res;
  };
}

/** Where boot stands: a user, off to the login, a login that didn't stick, or Friday unreachable. */
export type Boot = { kind: "user"; me: Me } | { kind: "login" } | { kind: "loop" } | { kind: "error"; message: string };

/** The mark boot leaves when it sends the browser to the login, to notice coming straight back without a session. */
export const LOGIN_MARK = "friday:login-at";
/** Coming back without a session this soon after being sent to the login means the login didn't stick. */
export const LOOP_MS = 30_000;

export async function loadMe(doFetch: typeof fetch, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, now: () => number = Date.now): Promise<Boot> {
  let res: Response;
  try {
    res = await doFetch("/api/me", { headers: { accept: "application/json" } });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 401) {
    const last = Number(storage.getItem(LOGIN_MARK));
    if (last && now() - last < LOOP_MS) return { kind: "loop" };
    storage.setItem(LOGIN_MARK, String(now()));
    return { kind: "login" };
  }
  if (!res.ok) return { kind: "error", message: `${res.status} ${res.statusText}` };
  storage.removeItem(LOGIN_MARK);
  return { kind: "user", me: (await res.json()) as Me };
}

/** Pages only admins see: everything under /settings. */
export const isAdminPath = (path: string): boolean => path === "/settings" || path.startsWith("/settings/");

/** The sidebar items a user sees: the System group is for admins. */
export const visibleItems = <T extends { group: string }>(items: readonly T[], role: Role | undefined): T[] =>
  items.filter((i) => i.group !== "System" || role === "admin");

/** Log out of Friday; resolves with the provider's end-session URL, when it has one. */
export async function logout(doFetch: typeof fetch): Promise<string | null> {
  const res = await doFetch("/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(`logout failed: ${res.status}`);
  const body = (await res.json()) as { endSessionUrl?: string | null };
  return body.endSessionUrl ?? null;
}
