/**
 * The users API: `/api/me` for everyone, and the admin's list with disable and enable. The router has already checked
 * the session and the role (admin-only for `/api/users`), so handlers read the user from the request. No response
 * carries a token or a subject.
 */
import { sendJson, type NodeHandler, type Router } from "../router.js";
import { requestUser, type Auth } from "./auth.js";
import type { SessionStore } from "./sessions.js";
import { UserConflict, UserNotFound, type User, type UserStore } from "./users.js";

export interface UserRouteDeps {
  auth: Auth;
  users: UserStore;
  sessions: SessionStore;
  log?: Pick<Console, "log" | "warn">;
  onDisabled?: (userId: string) => void;
}

export interface UserEntry {
  id: string;
  name: string;
  email: string | null;
  role: User["role"];
  owner: boolean;
  disabled: boolean;
  firstLoginAt: string;
  lastLoginAt: string;
}

const entry = (u: User, ownerId: string | undefined): UserEntry => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  owner: u.id === ownerId,
  disabled: u.disabled,
  firstLoginAt: u.firstLoginAt,
  lastLoginAt: u.lastLoginAt,
});

export function addUserRoutes(router: Router, deps: UserRouteDeps): void {
  const { auth, users, sessions } = deps;
  const log = deps.log ?? console;

  router.add("GET", "/api/me", (req, res) => {
    const me = requestUser(req);
    if (!me) return sendJson(res, { error: "unauthenticated" }, 401);
    sendJson(res, { id: me.id, name: me.name, email: me.email, role: me.role, owner: me.id === users.ownerId(), authEnabled: auth.enabled });
  });

  router.add("GET", "/api/users", (_req, res) => {
    const ownerId = users.ownerId();
    sendJson(res, { users: users.list().map((u) => entry(u, ownerId)) });
  });

  const setDisabled = (disabled: boolean): NodeHandler => (req, res, { id }) => {
    const actor = requestUser(req);
    if (!actor) return sendJson(res, { error: "unauthenticated" }, 401);
    try {
      const user = users.setDisabled(id, disabled, actor.id);
      if (disabled) {
        const ended = sessions.endUser(id);
        deps.onDisabled?.(id);
        log.log(`auth: ${actor.name} (${actor.id}) disabled ${user.name} (${id}); ${ended} session(s) ended`);
      } else {
        log.log(`auth: ${actor.name} (${actor.id}) enabled ${user.name} (${id})`);
      }
      sendJson(res, entry(user, users.ownerId()));
    } catch (e) {
      if (e instanceof UserNotFound) return sendJson(res, { error: "unknown user" }, 404);
      if (e instanceof UserConflict) return sendJson(res, { error: e.message }, 409);
      throw e;
    }
  };
  router.add("POST", "/api/users/:id/disable", setDisabled(true));
  router.add("POST", "/api/users/:id/enable", setDisabled(false));
}
