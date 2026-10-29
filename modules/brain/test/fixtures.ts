import { openModuleDb } from "@friday/sdk/db";
import { migrations } from "../src/schema.js";
import { BrainStore } from "../src/store.js";
import { assignRowsToOwner } from "../src/users.js";

/** The user whose brain the store tests run through: the owner the brain from before users went to. */
export const OWNER = { id: "u1", name: "Raymond" };

/**
 * A migrated in-memory brain, as after an upgrade: the brain the migrations seeded is the owner's, and `store` is
 * that user's store. A clock that advances one second per read. `forUser` gives another user's store on the same db.
 */
export function brainStore(start = "2026-09-29T08:00:00.000Z") {
  const database = openModuleDb(":memory:", "brain");
  database.migrate(migrations);
  assignRowsToOwner(database.db, OWNER, { warn() {} });
  let t = Date.parse(start);
  let n = 0;
  const now = () => new Date((t += 1000));
  const opts = { now, newId: () => `p${++n}` };
  const store = new BrainStore(database.db, OWNER.id, opts);
  const forUser = (user: { id: string; name: string }) => {
    const s = new BrainStore(database.db, user.id, opts);
    s.ensure(user.name);
    return s;
  };
  return { store, forUser, db: database.db, close: () => database.close(), setTime: (iso: string) => void (t = Date.parse(iso)) };
}

/** Rows of a query as plain objects (node:sqlite rows have a null prototype). */
export const rows = (r: unknown[]) => r.map((x) => ({ ...(x as object) }));
