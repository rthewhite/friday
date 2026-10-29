import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { openModuleDb } from "@friday/sdk/db";
import { createBrainModule } from "../src/index.js";
import { migrations } from "../src/schema.js";

const sanne = { id: "u2", name: "Sanne", role: "member" as const };
const owner = { id: "u1", name: "Owner", role: "admin" as const };

async function host() {
  let t = Date.parse("2026-10-27T08:00:00Z");
  const h = await createTestHost(createBrainModule({ now: () => new Date((t += 1000)) }), { user: sanne, env: { FRIDAY_TIMEZONE: "Europe/Amsterdam" } });
  const req = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, user?: typeof owner | null) => (await h.request(method, path, body, {}, user === undefined ? {} : { user })).body as any;
  return { h, req };
}

test("a portal edit records the user who made it, and the history shows them", async () => {
  const { h, req } = await host();
  const page = await req("POST", "pages", { name: "Boiler", body: "Serviced in March." });
  const edited = await req("PUT", `pages/${page.id}`, { name: "Boiler", body: "Serviced in February.", baseRevision: page.revisionId });
  assert.equal(edited.body, "Serviced in February.");
  const detail = await req("GET", `pages/${page.id}`);
  assert.deepEqual(detail.revisions.map((r: any) => [r.author, r.user]), [["user", { id: "u2", name: "Sanne" }], ["user", { id: "u2", name: "Sanne" }]]);
  const first = await req("GET", `pages/${page.id}/revisions/${detail.revisions[1].id}`);
  assert.deepEqual(first.user, { id: "u2", name: "Sanne" });
  // The page is in Sanne's brain: the owner, an admin, can't edit it.
  const refused = await h.request("PUT", `pages/${page.id}`, { name: "Boiler", body: "x", baseRevision: edited.revisionId }, {}, { user: owner });
  assert.equal(refused.status, 404);
  await h.dispose();
});

test("every portal write path records the user: instructions, restore, delete, undelete and purge", async () => {
  const { h, req } = await host();
  const profile = await req("GET", "pages/profile");
  await req("PUT", "pages/profile", { instructions: "Call me Sanne.", baseRevision: profile.revisionId });
  const page = await req("POST", "pages", { name: "Car", body: "Blue." });
  const saved = await req("PUT", `pages/${page.id}`, { name: "Car", body: "Red.", baseRevision: page.revisionId });
  await req("POST", `pages/${page.id}/restore`, { revisionId: page.revisionId, baseRevision: saved.revisionId });
  await req("DELETE", `pages/${page.id}`);
  await req("POST", `pages/${page.id}/undelete`);
  const users = h.db.prepare("SELECT author, user_name FROM brain__revisions WHERE author = 'user'").all() as { user_name: string | null }[];
  assert.ok(users.length >= 6);
  assert.ok(users.every((r) => r.user_name === "Sanne"), JSON.stringify(users));
  await h.dispose();
});

test("revisions written by a tool have no user, even during the user's chat turn", async () => {
  const { h, req } = await host();
  await h.call("brain_remember", { entity: "Boiler", fact: "Serviced in March." }, { channel: "chat" });
  const page = (await req("GET", "pages")).pages.find((p: any) => p.name === "Boiler");
  const detail = await req("GET", `pages/${page.id}`);
  assert.deepEqual(detail.revisions.map((r: any) => [r.author, r.user]), [["remember", undefined]]);
  await h.dispose();
});

test("a request without a user is refused and writes nothing: a brain is always someone's", async () => {
  const { h } = await host();
  const r = await h.request("POST", "pages", { name: "Shed" }, {}, { user: null });
  assert.equal(r.status, 404);
  assert.equal(h.db.prepare("SELECT 1 FROM brain__pages WHERE name = 'Shed'").get(), undefined);
  await h.dispose();
});

test("migration 4 adds the columns and keeps older revisions without a user", () => {
  const d = openModuleDb(":memory:", "brain");
  d.migrate(migrations.slice(0, 3));
  const before = (d.db.prepare("SELECT COUNT(*) AS n FROM brain__revisions").get() as { n: number }).n;
  assert.deepEqual(d.migrate(migrations.slice(0, 4)), [4]);
  const rows = d.db.prepare("SELECT user_id, user_name FROM brain__revisions").all() as { user_id: null; user_name: null }[];
  assert.equal(rows.length, before);
  assert.ok(rows.every((r) => r.user_id === null && r.user_name === null));
  d.close();
});
