import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHost } from "@friday/sdk/test";
import { openModuleDb } from "@friday/sdk/db";
import brain from "../src/index.js";
import { migrations } from "../src/schema.js";

test("after the first start the brain holds one page, the empty profile, with one system revision", async () => {
  const h = await createTestHost(brain);
  const pages = h.db.prepare("SELECT id, name, type, body, is_profile, revision_id, deleted_at FROM brain__pages").all().map((r) => ({ ...r }));
  assert.deepEqual(pages, [{ id: "profile", name: "Profile", type: "other", body: "", is_profile: 1, revision_id: 1, deleted_at: null }]);
  const revisions = h.db.prepare("SELECT id, page_id, author, body FROM brain__revisions").all().map((r) => ({ ...r }));
  assert.deepEqual(revisions, [{ id: 1, page_id: "profile", author: "system", body: "" }]);
  assert.deepEqual(h.db.prepare("SELECT key, page_id FROM brain__names").all().map((r) => ({ ...r })), [{ key: "profile", page_id: "profile" }]);
  // A second profile is refused by the database itself.
  assert.throws(() => h.db.prepare("INSERT INTO brain__pages (id, name, type, is_profile, created_at, updated_at) VALUES ('x', 'Other', 'other', 1, '', '')").run(), /UNIQUE constraint failed/);
  await h.dispose();
});

test("a second start on the same data runs no migration and keeps the single profile", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "friday.db");
  const first = openModuleDb(file, "brain");
  assert.deepEqual(first.migrate(migrations), [1, 2]);
  first.close();
  const second = openModuleDb(file, "brain");
  assert.deepEqual(second.migrate(migrations), []);
  assert.equal(second.db.prepare("SELECT count(*) AS n FROM brain__pages").get()?.n, 1);
  second.close();
});
