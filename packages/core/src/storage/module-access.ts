import type { DatabaseSync } from "node:sqlite";
import type { CallUser } from "@friday/sdk";
import { patternRegExp } from "../agents/definition.js";
import { CORE_ID } from "../core-config.js";

export type AccessMode = "everyone" | "chosen";

export const ACCESS_MODES: readonly AccessMode[] = ["everyone", "chosen"];

/** Owner tags that have no access setting: core's own tools and the builtin module are always everyone's. */
export const ALWAYS_OPEN: ReadonlySet<string> = new Set([CORE_ID, "builtin"]);

/** A module's stored access setting, keyed by the owner tag its tools are registered with. */
export interface ModuleAccess {
  mode: AccessMode;
  /** The chosen users' ids. The household owner is allowed whether listed or not. */
  users: string[];
  /** Tool-name patterns (`*` matches anything) only the chosen users get, with mode `everyone`. */
  restricted: string[];
  /** The module's tool names when the setting was last saved. */
  known: string[];
  updatedAt: string;
}

export type ModuleAccessInput = Omit<ModuleAccess, "updatedAt">;

interface Compiled {
  mode: AccessMode;
  users: Set<string>;
  patterns: RegExp[];
}

/**
 * Who may use which module (`module-access`). Reads come from an in-memory copy with compiled patterns, refreshed on
 * every write, because the registry asks for every tool it declares or calls.
 */
export class ModuleAccessStore {
  private readonly cache = new Map<string, Compiled>();

  /** `isOwner` tells the household owner, who is allowed every module. */
  constructor(private readonly db: DatabaseSync, private readonly isOwner: (userId: string) => boolean, private readonly now: () => Date = () => new Date()) {
    for (const { owner } of db.prepare("SELECT owner FROM module_access").all() as { owner: string }[]) this.refresh(owner);
  }

  get(owner: string): ModuleAccess | undefined {
    const row = this.db.prepare("SELECT mode, restricted_json, known_json, updated_at FROM module_access WHERE owner = ?").get(owner) as
      | { mode: AccessMode; restricted_json: string; known_json: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    const users = (this.db.prepare("SELECT user_id FROM module_access_users WHERE owner = ? ORDER BY rowid").all(owner) as { user_id: string }[]).map((r) => r.user_id);
    return { mode: row.mode, users, restricted: JSON.parse(row.restricted_json) as string[], known: JSON.parse(row.known_json) as string[], updatedAt: row.updated_at };
  }

  /** Replaces the setting of `owner`. The caller validates the input; `core` and `builtin` are refused here too. */
  set(owner: string, a: ModuleAccessInput): ModuleAccess {
    if (ALWAYS_OPEN.has(owner)) throw new Error(`${owner} has no access setting`);
    const updatedAt = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO module_access (owner, mode, restricted_json, known_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner) DO UPDATE SET mode = excluded.mode, restricted_json = excluded.restricted_json, known_json = excluded.known_json, updated_at = excluded.updated_at",
        )
        .run(owner, a.mode, JSON.stringify(a.restricted), JSON.stringify(a.known), updatedAt);
      this.db.prepare("DELETE FROM module_access_users WHERE owner = ?").run(owner);
      const add = this.db.prepare("INSERT OR IGNORE INTO module_access_users (owner, user_id) VALUES (?, ?)");
      for (const id of a.users) add.run(owner, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.refresh(owner);
    return this.get(owner)!;
  }

  /** Back to the default (everyone, nothing restricted). Returns whether there was a setting. */
  clear(owner: string): boolean {
    const { changes } = this.db.prepare("DELETE FROM module_access WHERE owner = ?").run(owner);
    this.cache.delete(owner);
    return changes > 0;
  }

  /** Whether `user` gets module `owner` at all. A call or prompt without a user is the owner's. */
  allowsModule(owner: string, user: CallUser | undefined): boolean {
    const c = this.cache.get(owner);
    return !c || c.mode === "everyone" || this.chosen(c, user);
  }

  /** Whether `user` may use tool `tool` of module `owner`. */
  allowsTool(owner: string, tool: string, user: CallUser | undefined): boolean {
    const c = this.cache.get(owner);
    if (!c) return true;
    if (c.mode === "chosen") return this.chosen(c, user);
    return this.chosen(c, user) || !c.patterns.some((re) => re.test(tool));
  }

  private chosen(c: Compiled, user: CallUser | undefined): boolean {
    return user === undefined || this.isOwner(user.id) || c.users.has(user.id);
  }

  private refresh(owner: string): void {
    const a = this.get(owner);
    if (!a || ALWAYS_OPEN.has(owner)) {
      this.cache.delete(owner);
      return;
    }
    this.cache.set(owner, { mode: a.mode, users: new Set(a.users), patterns: a.restricted.map(patternRegExp) });
  }
}
