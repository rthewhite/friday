/**
 * Data without a user belongs to the household owner: devices act for the owner, and rows stored before users existed
 * are assigned to them. Assignment waits for an owner (a fresh install has none until the first admin logs in), runs
 * at startup and right after the owner is first recorded, and only ever changes rows without a user.
 */
import type { DatabaseSync } from "node:sqlite";
import type { CallUser, ModuleUsers } from "@friday/sdk";
import type { User, UserStore } from "./users.js";

export interface Assigned {
  conversations: number;
  agents: number;
  runs: number;
}

/** Give every conversation, agent and agent run without a user to `ownerId`. Safe to repeat. */
export function assignUnowned(db: DatabaseSync, ownerId: string): Assigned {
  db.exec("BEGIN");
  try {
    const out: Assigned = {
      conversations: Number(db.prepare("UPDATE conversations SET user_id = ? WHERE user_id IS NULL").run(ownerId).changes),
      agents: Number(db.prepare("UPDATE agents SET created_by = ? WHERE created_by IS NULL").run(ownerId).changes),
      runs: Number(db.prepare("UPDATE agent_runs SET user_id = ? WHERE user_id IS NULL").run(ownerId).changes),
    };
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Assign unowned rows to the owner now, when there is one, and again as soon as the owner is first recorded. */
export function followOwner(db: DatabaseSync, users: UserStore, log: Pick<Console, "log"> = console): () => void {
  const assign = (ownerId: string) => {
    const n = assignUnowned(db, ownerId);
    if (n.conversations || n.agents || n.runs) {
      log.log(`users: assigned ${n.conversations} conversation(s), ${n.agents} agent(s) and ${n.runs} agent run(s) without a user to the owner`);
    }
  };
  const owner = users.owner();
  if (owner) assign(owner.id);
  return users.onOwner((u) => assign(u.id));
}

const callUser = (u: User): CallUser => ({ id: u.id, name: u.name });

/** `ctx.users` for modules: the owner and the active users, by id and name only (no email, subject or role). */
export function moduleUsers(users: UserStore): ModuleUsers {
  return {
    owner: () => {
      const o = users.owner();
      return o && callUser(o);
    },
    list: () => users.list().filter((u) => !u.disabled).map(callUser),
    onOwner: (handler) => users.onOwner((u) => void handler(callUser(u))),
  };
}
