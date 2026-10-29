/**
 * A brain per user (user-privacy): `Brains.forUser` hands out one user's store, creating their brain on first use,
 * and `userStorage` gives each user their own nightly watermarks and markers in `ctx.storage`. What was stored
 * before brains had a user (pages, names, tombstones, runs and the storage keys) belongs to the household owner,
 * and `assignToOwner` gives it to them once there is one.
 */
import type { CallUser, ModuleDb, ModuleLogger, ModuleStorage } from "@friday/sdk";
import { BrainStore, type BrainStoreOptions } from "./store.js";

export class Brains {
  private readonly stores = new Map<string, BrainStore>();

  constructor(private readonly db: ModuleDb, private readonly opts: BrainStoreOptions = {}) {}

  /** `user`'s brain, created on first use with a subject page named after them. */
  forUser(user: CallUser): BrainStore {
    let store = this.stores.get(user.id);
    if (!store) {
      store = new BrainStore(this.db, user.id, this.opts);
      this.stores.set(user.id, store);
    }
    store.ensure(user.name);
    return store;
  }
}

/** The prefix of a user's keys in the module's storage. */
export const userKeyPrefix = (userId: string) => `user:${userId}:`;

/** `storage` as one user sees it: their keys only, under their prefix. */
export function userStorage(storage: ModuleStorage, userId: string): ModuleStorage {
  const prefix = userKeyPrefix(userId);
  return {
    get: (key) => storage.get(prefix + key),
    set: (key, value) => storage.set(prefix + key, value),
    delete: (key) => storage.delete(prefix + key),
    list: async (p = "") => (await storage.list(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}

/** The table part of `assignToOwner`, in one transaction; undefined when the owner already has a brain of their own. */
export function assignRowsToOwner(db: ModuleDb, owner: CallUser, log: Pick<ModuleLogger, "warn">): Pick<Assigned, "pages" | "runs"> | undefined {
  const unowned = !!db.prepare("SELECT 1 FROM brain__pages WHERE user_id IS NULL LIMIT 1").get();
  const theirs = !!db.prepare("SELECT 1 FROM brain__pages WHERE user_id = ? AND is_profile = 1").get(owner.id);
  if (unowned && theirs) {
    log.warn(`the brain from before users stays unassigned: the owner ${owner.name} already has a brain of their own`);
    return undefined;
  }
  return db.transaction(() => {
    const pages = Number(db.prepare("UPDATE brain__pages SET user_id = ? WHERE user_id IS NULL").run(owner.id).changes);
    db.prepare("UPDATE brain__names SET user_id = ? WHERE user_id IS NULL").run(owner.id);
    db.prepare("UPDATE brain__tombstones SET user_id = ? WHERE user_id IS NULL").run(owner.id);
    const runs = Number(db.prepare("UPDATE brain__runs SET user_id = ? WHERE user_id IS NULL").run(owner.id).changes);
    return { pages, runs };
  });
}

export interface Assigned {
  pages: number;
  runs: number;
  keys: number;
}

/**
 * Gives the brain stored without a user to the owner: pages (their revisions follow), names, tombstones, runs, and
 * the storage keys outside any user's prefix. Only data without a user changes, so it is safe to repeat. When the
 * owner already has a brain of their own (they used Friday before they became the owner), the old brain is left
 * as it is and a warning logged, since two profiles can't be merged here.
 */
export async function assignToOwner(db: ModuleDb, storage: ModuleStorage, owner: CallUser, log: ModuleLogger): Promise<Assigned> {
  const rows = assignRowsToOwner(db, owner, log);
  const out: Assigned = { pages: rows?.pages ?? 0, runs: rows?.runs ?? 0, keys: 0 };
  if (!rows) return out;
  const target = userStorage(storage, owner.id);
  for (const key of await storage.list()) {
    if (key.startsWith("user:")) continue;
    const value = await storage.get(key);
    if ((await target.get(key)) === undefined) await target.set(key, value);
    await storage.delete(key);
    out.keys++;
  }
  if (out.pages || out.runs || out.keys) log.log(`assigned the brain from before users to the owner: ${out.pages} page(s), ${out.runs} run(s), ${out.keys} key(s)`);
  return out;
}
