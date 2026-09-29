import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";

async function host(env: Record<string, string> = {}) {
  let t = Date.parse("2026-09-29T08:00:00Z");
  const h = await createTestHost(createBrainModule({ now: () => new Date((t += 1000)) }), { env });
  const req = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => {
    const r = await h.request(method, path, body);
    return { status: r.status, body: r.body as any };
  };
  const create = async (b: Record<string, unknown>) => (await req("POST", "pages", b)).body;
  return { h, req, create };
}

test("GET pages lists the profile budget, live pages with bodies, and deleted pages", async () => {
  const { req, create } = await host({ BRAIN_PROFILE_TOKEN_BUDGET: "10" });
  await req("PUT", "pages/profile", { name: "Profile", type: "other", aliases: [], body: "x".repeat(41), baseRevision: 1 });
  const anouk = await create({ name: "Anouk", type: "person", aliases: ["Noukie"], body: "Sister" });
  const car = await create({ name: "Old car" });
  await req("DELETE", `pages/${car.id}`);
  const { status, body } = await req("GET", "pages");
  assert.equal(status, 200);
  assert.deepEqual(body.profile, { id: "profile", usedTokens: 11, budgetTokens: 10, overBudget: true });
  assert.deepEqual(body.pages.map((p: any) => p.name), ["Anouk", "Profile"]);
  assert.deepEqual(body.pages[0], { id: anouk.id, name: "Anouk", type: "person", aliases: ["Noukie"], body: "Sister", isProfile: false, updatedAt: anouk.updatedAt, revisionId: anouk.revisionId });
  assert.equal(body.pages[1].isProfile, true);
  assert.deepEqual(body.deleted.map((d: any) => [d.id, d.name, typeof d.deletedAt]), [[car.id, "Old car", "string"]]);
  // Default budget.
  assert.equal((await (await host()).req("GET", "pages")).body.profile.budgetTokens, 800);
});

test("GET pages/:id carries revisions, outgoing links and backlinks; revisions/:rev the snapshot", async () => {
  const { req, create } = await host();
  const anouk = await create({ name: "Anouk", body: "Lives in [[Utrecht]]" });
  await create({ name: "Family", body: "- [[Anouk]] is my sister" });
  const saved = (await req("PUT", `pages/${anouk.id}`, { name: "Anouk", type: "person", aliases: [], body: "Lives in [[Utrecht]] and [[Family]]", baseRevision: anouk.revisionId })).body;
  const { status, body } = await req("GET", `pages/${anouk.id}`);
  assert.equal(status, 200);
  assert.equal(body.body, "Lives in [[Utrecht]] and [[Family]]");
  assert.deepEqual(body.revisions.map((r: any) => [r.id, r.author]), [[saved.revisionId, "user"], [anouk.revisionId, "user"]]);
  assert.deepEqual(body.links.map((l: any) => [l.target, l.pageName ?? null]), [["Utrecht", null], ["Family", "Family"]]);
  assert.deepEqual(body.backlinks.map((b: any) => [b.name, b.line]), [["Family", "- [[Anouk]] is my sister"]]);
  const rev = await req("GET", `pages/${anouk.id}/revisions/${anouk.revisionId}`);
  assert.equal(rev.body.body, "Lives in [[Utrecht]]");
  assert.equal((await req("GET", `pages/${anouk.id}/revisions/999`)).status, 404);
  assert.deepEqual((await req("GET", `pages/${anouk.id}/revisions/abc`)).body.code, "invalid");
  assert.deepEqual(await req("GET", "pages/nope"), { status: 404, body: { error: "no such page", code: "not_found" } });
});

test("POST pages creates with 201; a taken name is 409 name_taken", async () => {
  const { req } = await host();
  const r = await req("POST", "pages", { name: "Anouk", type: "person" });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, "Anouk");
  const dup = await req("POST", "pages", { name: "anouk" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "name_taken");
  assert.deepEqual(dup.body.names, ["anouk"]);
  assert.equal((await req("POST", "pages", { name: "" })).body.code, "invalid");
  assert.equal((await req("POST", "pages", "not an object")).status, 400);
});

test("PUT pages/:id saves with 200 and answers a stale base with 409 and the current page", async () => {
  const { h, req, create } = await host();
  const p = await create({ name: "Anouk", type: "person", body: "Sister" });
  // Meanwhile the model appends a note.
  await h.call("brain_remember", { entity: "Anouk", fact: "Birthday 3 November" });
  const stale = await req("PUT", `pages/${p.id}`, { name: "Anouk", type: "person", aliases: [], body: "My edit", baseRevision: p.revisionId });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale");
  assert.match(stale.body.current.body, /Birthday 3 November/);
  const ok = await req("PUT", `pages/${p.id}`, { name: "Anouk", type: "person", aliases: [], body: "My edit", baseRevision: stale.body.current.revisionId });
  assert.equal(ok.status, 200);
  const read = (await req("GET", `pages/${p.id}`)).body;
  assert.equal(read.body, "My edit");
  assert.equal(read.revisions[0].author, "user");
  assert.equal((await req("PUT", `pages/${p.id}`, { name: "Anouk", body: "x" })).body.code, "invalid");
  assert.equal((await req("PUT", "pages/profile", { name: "Me", type: "other", aliases: [], body: "", baseRevision: 1 })).body.code, "profile");
});

test("POST pages/:id/restore records the old content as a new revision", async () => {
  const { req, create } = await host();
  let p = await create({ name: "Anouk", body: "v1" });
  const first = p.revisionId;
  for (const body of ["v2", "v3"]) p = (await req("PUT", `pages/${p.id}`, { name: "Anouk", type: "other", aliases: [], body, baseRevision: p.revisionId })).body;
  const r = await req("POST", `pages/${p.id}/restore`, { revisionId: first, baseRevision: p.revisionId });
  assert.equal(r.status, 200);
  assert.equal(r.body.body, "v1");
  const history = (await req("GET", `pages/${p.id}`)).body.revisions;
  assert.equal(history.length, 4);
  assert.equal(history[0].note, `restored revision ${first}`);
});

test("DELETE soft-deletes with 204; the profile can't be deleted; undelete is 409 when the name was reused", async () => {
  const { req, create } = await host();
  const car = await create({ name: "Old car" });
  assert.equal((await req("DELETE", `pages/${car.id}`)).status, 204);
  assert.ok((await req("GET", `pages/${car.id}`)).body.deletedAt);
  assert.deepEqual(await req("DELETE", "pages/profile"), { status: 400, body: { error: "the profile cannot be deleted", code: "profile" } });
  await create({ name: "Old car" });
  const u = await req("POST", `pages/${car.id}/undelete`);
  assert.equal(u.status, 409);
  assert.equal(u.body.code, "name_taken");
  assert.deepEqual(u.body.names, ["Old car"]);
});

test("purge: a wrong confirmation is 400, a live page 409, and a purge lists the unlinked pages", async () => {
  const { req, create } = await host();
  const job = await create({ name: "Old job" });
  await req("PUT", "pages/profile", { name: "Profile", type: "other", aliases: [], body: "Worked at [[Old job]]", baseRevision: 1 });
  const live = await req("POST", `pages/${job.id}/purge`, { confirm: "Old job" });
  assert.equal(live.status, 409);
  assert.equal(live.body.code, "not_deleted");
  await req("DELETE", `pages/${job.id}`);
  const wrong = await req("POST", `pages/${job.id}/purge`, { confirm: "old job" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "invalid");
  const done = await req("POST", `pages/${job.id}/purge`, { confirm: "Old job" });
  assert.deepEqual(done, { status: 200, body: { unlinked: ["Profile"] } });
  assert.equal((await req("GET", `pages/${job.id}`)).status, 404);
  assert.equal((await req("GET", "pages/profile")).body.body, "Worked at Old job");
  const again = await req("POST", "pages", { name: "Old job" });
  assert.equal(again.status, 201, "a user create lifts the tombstone");
});
