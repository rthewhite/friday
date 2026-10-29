import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations, openDatabase, schemaVersion } from "../src/storage/db.js";
import { UserStore, type LoginClaims } from "../src/auth/users.js";
import { assignUnowned, followOwner } from "../src/auth/ownership.js";

const quiet = { log() {} };

const admin = (subject: string): LoginClaims => ({ issuer: "https://auth.example/", subject, email: `${subject}@x`, name: subject, role: "admin" });

function seedLegacy(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO conversations (id, channel, started_at, last_activity_at) VALUES ('c1', 'voice', 't', 't'), ('c2', 'chat', 't', 't');
    INSERT INTO agents (name, description, instructions, enabled, startable, tools_json, budgets_json, created_at, updated_at) VALUES ('weekly-review', '', '', 1, 1, '[]', '{}', 't', 't');
    INSERT INTO agent_runs (id, agent, trigger, started_at, outcome) VALUES ('r1', 'weekly-review', 'schedule', 't', 'ok');
  `);
}

const owners = (db: DatabaseSync) => ({
  conversations: db.prepare("SELECT id, user_id FROM conversations ORDER BY id").all().map((r) => ({ ...r })),
  agents: db.prepare("SELECT name, created_by FROM agents ORDER BY name").all().map((r) => ({ ...r })),
  runs: db.prepare("SELECT id, user_id FROM agent_runs ORDER BY id").all().map((r) => ({ ...r })),
});

test("a version-12 database gains agents.created_by, and existing agents keep no creator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const old = new DatabaseSync(join(dir, "friday.db"));
  migrate(old, migrations.filter((m) => m.version <= 12), quiet);
  seedLegacy(old);
  old.close();

  const db = openDatabase(dir, "friday.db", quiet);
  assert.equal(schemaVersion(db), 13);
  assert.deepEqual(owners(db).agents, [{ name: "weekly-review", created_by: null }]);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE user_id = 'u1' ORDER BY last_activity_at DESC").all();
  assert.match(JSON.stringify(plan), /conversations_user_activity/);
  db.close();
});

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  return db;
}

test("assignment changes only rows without a user, and repeating it changes nothing", () => {
  const db = fresh();
  seedLegacy(db);
  db.exec("UPDATE conversations SET user_id = 'u2' WHERE id = 'c2'");
  assert.deepEqual(assignUnowned(db, "u1"), { conversations: 1, agents: 1, runs: 1 });
  assert.deepEqual(owners(db), {
    conversations: [{ id: "c1", user_id: "u1" }, { id: "c2", user_id: "u2" }],
    agents: [{ name: "weekly-review", created_by: "u1" }],
    runs: [{ id: "r1", user_id: "u1" }],
  });
  assert.deepEqual(assignUnowned(db, "u3"), { conversations: 0, agents: 0, runs: 0 });
  assert.equal(owners(db).agents[0].created_by, "u1");
});

test("upgrade with an owner: everything without a user goes to the owner at startup", () => {
  const db = fresh();
  const users = new UserStore(db);
  const r = users.provision(admin("raymond"));
  assert.ok(r.ok);
  seedLegacy(db);
  followOwner(db, users, quiet);
  assert.deepEqual(new Set(Object.values(owners(db)).flat().map((x) => Object.values(x)[1])), new Set([r.user.id]));
});

test("fresh install: nothing is assigned until the first admin logs in, then everything so far is theirs", () => {
  const db = fresh();
  const users = new UserStore(db);
  followOwner(db, users, quiet);
  seedLegacy(db);
  assert.equal(owners(db).conversations[0].user_id, null);
  users.provision({ ...admin("sanne"), role: "member" });
  assert.equal(owners(db).conversations[0].user_id, null, "a member records no owner");
  const r = users.provision(admin("raymond"));
  assert.ok(r.ok);
  assert.deepEqual(owners(db).runs, [{ id: "r1", user_id: r.user.id }]);
  assert.deepEqual(owners(db).conversations.map((c) => c.user_id), [r.user.id, r.user.id]);
});

test("without auth configured the dev user receives the data at startup", () => {
  const db = fresh();
  seedLegacy(db);
  followOwner(db, new UserStore(db, undefined, { devOwner: true }), quiet);
  assert.deepEqual(owners(db).agents, [{ name: "weekly-review", created_by: "dev" }]);
});
