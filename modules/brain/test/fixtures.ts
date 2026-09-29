import { openModuleDb } from "@friday/sdk/db";
import { migrations } from "../src/schema.js";
import { BrainStore } from "../src/store.js";

/** A migrated in-memory brain with a clock that advances one second per read. */
export function brainStore(start = "2026-09-29T08:00:00.000Z") {
  const database = openModuleDb(":memory:", "brain");
  database.migrate(migrations);
  let t = Date.parse(start);
  let n = 0;
  const now = () => new Date((t += 1000));
  const store = new BrainStore(database.db, { now, newId: () => `p${++n}` });
  return { store, db: database.db, close: () => database.close(), setTime: (iso: string) => void (t = Date.parse(iso)) };
}

/** Rows of a query as plain objects (node:sqlite rows have a null prototype). */
export const rows = (r: unknown[]) => r.map((x) => ({ ...(x as object) }));
