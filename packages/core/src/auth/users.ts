/**
 * Users in friday.db, provisioned just in time at login. A user is identified by the (issuer, subject) the provider
 * gives, never by email; the profile and the role follow the claims at every login and claim refresh. The first admin
 * to log in is recorded once as the household owner. Without configured auth, the fixed dev user stands in.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type Role = "admin" | "member";

export interface User {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  disabled: boolean;
  firstLoginAt: string;
  lastLoginAt: string;
}

/** What a login (or a claim refresh) says about a person, after the group rule picked the role. */
export interface LoginClaims {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
  role: Role;
}

export type ProvisionResult =
  | { ok: true; user: User; created: boolean }
  /** An unknown subject whose email belongs to another user: refused, nothing created. */
  | { ok: false; reason: "email_conflict"; conflictingUserId: string };

export const DEV_USER_ID = "dev";
const DEV_ISSUER = "dev";

export class UserNotFound extends Error {}
/** Disabling yourself or the dev user; maps to 409. */
export class UserConflict extends Error {}

interface Row {
  id: string;
  email: string | null;
  name: string;
  role: Role;
  disabled: number;
  first_login_at: string;
  last_login_at: string;
}

const COLUMNS = "id, email, name, role, disabled, first_login_at, last_login_at";

const toUser = (r: Row): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  disabled: r.disabled === 1,
  firstLoginAt: r.first_login_at,
  lastLoginAt: r.last_login_at,
});

const displayName = (c: LoginClaims): string => c.name?.trim() || c.preferredUsername?.trim() || c.email?.trim() || c.subject;

export class UserStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Create the user on their first login, or update their profile and role. Records the owner when due. */
  provision(c: LoginClaims): ProvisionResult {
    const at = this.now().toISOString();
    const email = c.email?.trim() || null;
    const name = displayName(c);
    const known = this.db.prepare("SELECT id FROM users WHERE issuer = ? AND subject = ?").get(c.issuer, c.subject) as { id: string } | undefined;
    if (known) {
      this.db.prepare("UPDATE users SET email = ?, name = ?, role = ?, last_login_at = ? WHERE id = ?").run(email, name, c.role, at, known.id);
      const user = this.get(known.id)!;
      this.recordOwner(user);
      return { ok: true, user, created: false };
    }
    if (email) {
      const clash = this.db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
      if (clash) return { ok: false, reason: "email_conflict", conflictingUserId: clash.id };
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO users (id, issuer, subject, email, name, role, first_login_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, c.issuer, c.subject, email, name, c.role, at, at);
    const user = this.get(id)!;
    this.recordOwner(user);
    return { ok: true, user, created: true };
  }

  /** Update a known user from refreshed claims, without counting it as a login. Undefined when unknown. */
  refresh(id: string, c: Omit<LoginClaims, "issuer" | "subject">): User | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const name = c.name?.trim() || c.preferredUsername?.trim() || c.email?.trim() || current.name;
    this.db.prepare("UPDATE users SET email = ?, name = ?, role = ? WHERE id = ?").run(c.email?.trim() || current.email, name, c.role, id);
    const user = this.get(id)!;
    this.recordOwner(user);
    return user;
  }

  /** The fixed admin used when auth is not configured, created on first use. */
  devUser(): User {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, issuer, subject, email, name, role, first_login_at, last_login_at)
         VALUES (?, ?, ?, NULL, 'Dev', 'admin', ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .run(DEV_USER_ID, DEV_ISSUER, DEV_USER_ID, at, at);
    return this.get(DEV_USER_ID)!;
  }

  get(id: string): User | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row | undefined;
    return row && toUser(row);
  }

  /** The issuer and subject a user logs in with; never leaves core. */
  identity(id: string): { issuer: string; subject: string } | undefined {
    return this.db.prepare("SELECT issuer, subject FROM users WHERE id = ?").get(id) as { issuer: string; subject: string } | undefined;
  }

  /** Every user, by name. */
  list(): User[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY name COLLATE NOCASE, id`).all() as unknown as Row[]).map(toUser);
  }

  /** Disable or enable `id`. `actorId` is the admin doing it, who may not disable themselves. */
  setDisabled(id: string, disabled: boolean, actorId: string): User {
    const user = this.get(id);
    if (!user) throw new UserNotFound(`unknown user ${id}`);
    if (disabled && id === actorId) throw new UserConflict("you can't disable yourself");
    if (disabled && id === DEV_USER_ID) throw new UserConflict("the dev user can't be disabled");
    this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
    return this.get(id)!;
  }

  /** The household owner's user id, once recorded. */
  ownerId(): string | undefined {
    return (this.db.prepare("SELECT user_id FROM auth_owner WHERE id = 1").get() as { user_id: string } | undefined)?.user_id;
  }

  /** The first admin (not the dev user, not disabled) becomes the owner, exactly once. */
  private recordOwner(user: User): void {
    if (user.role !== "admin" || user.disabled || user.id === DEV_USER_ID) return;
    this.db.prepare("INSERT INTO auth_owner (id, user_id, recorded_at) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING").run(user.id, this.now().toISOString());
  }
}
