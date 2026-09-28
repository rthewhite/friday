/** A conversation store on an in-memory database with a controllable clock and captured errors. */
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { ConversationStore, type ConversationStoreOptions } from "../src/conversations/store.js";

export function setup(opts: ConversationStoreOptions = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, { log() {} });
  let t = Date.parse("2026-10-01T10:00:00.000Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
  const errors: string[] = [];
  const store = new ConversationStore(db, { now: clock.now, log: { log() {}, error: (...a: unknown[]) => void errors.push(a.join(" ")) }, ...opts });
  return { db, store, clock, errors };
}
