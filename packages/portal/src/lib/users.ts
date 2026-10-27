/** System > Users: the users Friday knows, as listed by `GET /api/users`, and what an admin may do with each. */

export interface UserEntry extends Record<string, unknown> {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "member";
  owner: boolean;
  disabled: boolean;
  firstLoginAt: string;
  lastLoginAt: string;
}

/** The dev user's fixed id (no login configured). */
export const DEV_USER_ID = "dev";

/** Disable is offered for others, never for yourself or the dev user; Enable for anyone disabled. */
export function actionFor(user: Pick<UserEntry, "id" | "disabled">, meId: string | undefined): "disable" | "enable" | null {
  if (user.disabled) return "enable";
  return user.id === meId || user.id === DEV_USER_ID ? null : "disable";
}

export const statusTone = (u: Pick<UserEntry, "disabled">): "success" | "error" => (u.disabled ? "error" : "success");

/** Admins first, then by name. */
export const sortUsers = (users: readonly UserEntry[]): UserEntry[] =>
  [...users].sort((a, b) => (a.role === b.role ? 0 : a.role === "admin" ? -1 : 1) || a.name.localeCompare(b.name));
