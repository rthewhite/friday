import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmRequest } from "@friday/sdk";
import { createTestHost, type TestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { renderConsolidation, validatePlan, type Plan } from "../src/nightly/consolidate.js";
import { BrainStore } from "../src/store.js";
import { brainStore } from "./fixtures.js";
import { loadFixtures, seedFixture, type Fixture } from "./nightly/load.js";

const fixtures = new Map(loadFixtures().map((f) => [f.name, f]));
const fixture = (name: string): Fixture => fixtures.get(name)!;

/** Replaces `{{id:Name}}` and `{{rev:Name}}` in a fixture plan with the seeded page's id and current revision. */
function fill(h: TestHost, plan: unknown): Plan {
  const text = JSON.stringify(plan)
    .replace(/\{\{id:([^}]+)\}\}/g, (_, n: string) => (h.db.prepare("SELECT page_id FROM brain__names WHERE key = ?").get(n.toLowerCase()) as { page_id: string }).page_id)
    .replace(/"\{\{rev:([^}]+)\}\}"/g, (_, n: string) => String((h.db.prepare("SELECT p.revision_id AS r FROM brain__names k JOIN brain__pages p ON p.id = k.page_id WHERE k.key = ?").get(n.toLowerCase()) as { r: number }).r));
  return JSON.parse(text) as Plan;
}

type PlanAnswer = (req: LlmRequest, n: number) => unknown;

async function host(plan: PlanAnswer = () => ({ actions: [], note: "tidy" }), env: Record<string, string> = {}) {
  const requests: LlmRequest[] = [];
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-30T01:00:00Z") }), {
    env,
    llm: (req) => {
      if ((req.schema as { properties?: Record<string, unknown> })?.properties?.notes) return JSON.stringify({ notes: [] });
      requests.push(req);
      const a = plan(req, requests.length);
      return typeof a === "string" ? a : JSON.stringify(a);
    },
  });
  const page = (name: string) => {
    const row = h.db.prepare("SELECT p.* FROM brain__names n JOIN brain__pages p ON p.id = n.page_id WHERE n.key = ?").get(name.toLowerCase()) as { id: string; name: string; body: string; revision_id: number; aliases_json: string } | undefined;
    return row && { ...row };
  };
  const run = async () => {
    const r = await h.runJob("nightly");
    return { ...r, row: { ...(h.db.prepare("SELECT * FROM brain__runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>) } };
  };
  return { h, requests, page, run };
}

// ---- 4.1 trigger and input ----

test("no model call when no page changed, and consolidation's own writes don't count as changes", async () => {
  const empty = await host();
  const r = await empty.run();
  assert.equal(empty.requests.length, 0);
  assert.match(r.summary!, /nothing to consolidate/);

  const t = await host((req, n) => (n === 1 ? fill(t.h, fixture("fold-notes").fake!.plan) : { actions: [], note: "" }));
  await seedFixture(t.h, fixture("fold-notes"));
  await t.run();
  assert.equal(t.requests.length, 1);
  const second = await t.run();
  assert.equal(t.requests.length, 1, "the plan's own rewrite is no reason to run again");
  assert.match(second.summary!, /nothing to consolidate/);
});

test("the request marks changed pages and carries revisions, the budget, and forgotten names", async () => {
  const t = await host();
  await seedFixture(t.h, fixture("fold-notes"));
  const job = (await t.h.request("POST", "pages", { name: "Old job" })).body as { id: string };
  await t.h.request("DELETE", `pages/${job.id}`);
  await t.h.request("POST", `pages/${job.id}/purge`, { confirm: "Old job" });
  await t.run();
  const p = t.requests[0]!.messages![0]!.text;
  const anouk = t.page("Anouk")!;
  assert.match(p, new RegExp(`### Anouk \\[id ${anouk.id}, revision ${anouk.revision_id}\\] \\(changed\\)\\ntype person; aliases: Noukie\\nMy sister\\. Lives in Amsterdam\\.`));
  assert.match(p, /^Profile budget: about 0 of 800 tokens\./);
  assert.match(p, /## Deliberately forgotten names \(never use\)\n- Old job/);
  assert.equal(t.requests[0]!.system!.includes("rewrite:"), true);
  assert.deepEqual([t.requests[0]!.model, t.requests[0]!.maxOutputTokens, t.requests[0]!.timeoutMs], ["standard", 32768, 300000]);
  // Later only the edited page is marked.
  const home = t.page("Home")!;
  await t.h.request("PUT", `pages/${home.id}`, { name: "Home", type: "place", aliases: [], body: `${home.body}\nThe bins go out on Tuesday.`, baseRevision: home.revision_id });
  await t.run();
  const q = t.requests[1]!.messages![0]!.text;
  assert.match(q, /### Home \[id [^\]]+\] \(changed\)/);
  assert.doesNotMatch(q, /### Anouk \[id [^\]]+\] \(changed\)/);
});

test("beyond the bound, changed pages and their link neighbours stay in full and the rest become an index", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  const anouk = store.create({ name: "Anouk", body: "Sister, see [[Family]]" }, "user");
  store.create({ name: "Family", body: "The family page" }, "user");
  for (let i = 0; i < 5; i++) store.create({ name: `Filler ${i}`, body: "x".repeat(3000) }, "user");
  const text = renderConsolidation(store, new Set([anouk.id]), 800, 5000);
  assert.match(text, /### Anouk \[[^\]]+\] \(changed\)/);
  assert.match(text, /### Family \[[^\]]+\]\n/);
  assert.match(text, /## Other pages \(index only, not in full\)\n- Filler/);
});

// ---- 4.2 validation ----

function scene() {
  const s = brainStore();
  const anouk = s.store.create({ name: "Anouk", type: "person", body: "My sister. Lives in Amsterdam.\n\n## Notes\n- 2026-09-29: Moved to Utrecht." }, "user");
  const home = s.store.create({ name: "Home", type: "place", body: "Wifi password is on the router label.\nThe boiler is in the attic." }, "user");
  const noukie = s.store.create({ name: "Noukie", type: "person", body: "Also Anouk?" }, "user");
  return { ...s, anouk, home, noukie };
}
const reasonsFor = (store: BrainStore, plan: Plan, budget = 800) => validatePlan(store, plan, budget).join("\n");

test("a plan is refused for stale bases, unknown or deleted pages and empty bodies", (t) => {
  const { store, close, anouk, home } = scene();
  t.after(close);
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: anouk.id, base: anouk.revisionId - 1, body: "x" }], note: "" }), /Anouk is stale: its current revision is \d+/);
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: "nope", base: 1, body: "x" }], note: "" }), /page "nope" doesn't exist/);
  store.softDelete(home.id, "user");
  const gone = store.get(home.id)!;
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: gone.id, base: gone.revisionId, body: "x" }], note: "" }), /Home is deleted/);
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: anouk.id, base: anouk.revisionId, body: "  ", dropped: [] }], note: "" }), /the body is empty/);
});

test("a plan may not rename or merge the profile, or use a forgotten or taken name", (t) => {
  const { store, close, anouk, noukie } = scene();
  t.after(close);
  const profile = store.profile();
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: profile.id, base: profile.revisionId, name: "Me", body: "x" }], note: "" }), /the profile's name and type can't change/);
  assert.match(reasonsFor(store, { actions: [{ kind: "merge", from: noukie.id, into: profile.id, bases: { from: noukie.revisionId, into: profile.revisionId }, body: "Also Anouk?" }], note: "" }), /the profile can't be merged/);
  const job = store.create({ name: "Old job" }, "user");
  store.softDelete(job.id, "user");
  store.purge(job.id, "Old job", "user");
  assert.match(reasonsFor(store, { actions: [{ kind: "create", name: "old job", type: "project", body: "back" }], note: "" }), /"old job" was deliberately forgotten/);
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: noukie.id, base: noukie.revisionId, name: "Anouk", body: "Also Anouk?" }], note: "" }), /the name "Anouk" is already used by Anouk/);
  // A name freed by a merge in the same plan is fine.
  assert.equal(reasonsFor(store, {
    actions: [
      { kind: "merge", from: noukie.id, into: anouk.id, bases: { from: noukie.revisionId, into: anouk.revisionId }, body: "My sister. Moved to Utrecht. Also Anouk?", dropped: [{ line: "My sister. Lives in Amsterdam.", reason: "moved" }] },
      { kind: "create", name: "Noukie", body: "A different Noukie" },
    ],
    note: "",
  }), "");
});

test("a plan may not make an over-budget profile larger", (t) => {
  const { store, close } = scene();
  t.after(close);
  const profile = store.save("profile", { ...store.profile(), body: "x".repeat(400) }, "user");
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: profile.id, base: profile.revisionId, body: "x".repeat(420) }], note: "" }, 50), /the profile is over budget \(100 of 50 tokens\) and the plan makes it larger/);
  assert.equal(reasonsFor(store, { actions: [{ kind: "rewrite", page: profile.id, base: profile.revisionId, body: "x".repeat(400) }], note: "" }, 50), "");
});

test("an undeclared loss is refused, naming the page and the line; a declared supersession and a faithful rephrasing pass", (t) => {
  const { store, close, anouk, home } = scene();
  t.after(close);
  const lost = reasonsFor(store, { actions: [{ kind: "rewrite", page: home.id, base: home.revisionId, body: "The boiler is in the attic.", dropped: [] }], note: "" });
  assert.match(lost, /Home loses the line "Wifi password is on the router label\." without declaring it in dropped/);
  assert.equal(reasonsFor(store, {
    actions: [{ kind: "rewrite", page: anouk.id, base: anouk.revisionId, body: "My sister. Moved to Utrecht.", dropped: [{ line: "My sister. Lives in Amsterdam.", reason: "superseded by the 2026-09-29 note" }] }],
    note: "",
  }), "");
  // Folding a dated note into prose keeps its words, so it is preserved without being declared.
  assert.equal(reasonsFor(store, {
    actions: [{ kind: "rewrite", page: home.id, base: home.revisionId, body: "The wifi password: on the label of the router. Boiler: attic.", dropped: [] }],
    note: "",
  }), "");
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: anouk.id, base: anouk.revisionId, body: "My sister.", dropped: [] }], note: "" }), /Anouk loses the line "My sister\. Lives in Amsterdam\."[^]*Anouk loses the line "- 2026-09-29: Moved to Utrecht\."/);
});

test("a page may appear in only one action", (t) => {
  const { store, close, anouk, noukie } = scene();
  t.after(close);
  const r = reasonsFor(store, {
    actions: [
      { kind: "rewrite", page: anouk.id, base: anouk.revisionId, body: "My sister. Lives in Amsterdam.\nMoved to Utrecht." },
      { kind: "merge", from: noukie.id, into: anouk.id, bases: { from: noukie.revisionId, into: anouk.revisionId }, body: "My sister. Lives in Amsterdam. Moved to Utrecht. Also Anouk?" },
    ],
    note: "",
  });
  assert.match(r, /Anouk is already changed by action 1; one action per page/);
});

// ---- 4.3 application ----

test("a merge makes [[Noukie]] resolve to Anouk and soft-deletes Noukie", async () => {
  const t = await host(() => fill(t.h, fixture("merge-duplicates").fake!.plan));
  await seedFixture(t.h, fixture("merge-duplicates"));
  const noukie = t.page("Noukie")!;
  const r = await t.run();
  assert.equal(r.outcome, "ok");
  assert.match(r.summary!, /0 pages rewritten, 1 merge, 0 lines dropped/);
  const anouk = t.page("Anouk")!;
  assert.equal(anouk.body, "My sister, lives in Utrecht. Birthday: 3 November.");
  assert.deepEqual(JSON.parse(anouk.aliases_json as string), ["Noukie"]);
  assert.equal(t.page("noukie")!.id, anouk.id, "[[Noukie]] resolves to Anouk");
  assert.ok((t.h.db.prepare("SELECT deleted_at FROM brain__pages WHERE id = ?").get(noukie.id) as { deleted_at: string }).deleted_at);
  assert.deepEqual(JSON.parse(r.row.merges_json as string), [{ from: noukie.id, into: anouk.id }]);
  const authors = t.h.db.prepare("SELECT author, note FROM brain__revisions WHERE page_id IN (?, ?) ORDER BY id DESC LIMIT 2").all(noukie.id, anouk.id).map((x) => ({ ...x }));
  assert.deepEqual(authors, [{ author: "consolidation", note: "Merged Noukie into Anouk." }, { author: "consolidation", note: "merged into Anouk" }]);
});

test("a store error in the third action leaves the first two unapplied", async () => {
  const t = await host(() => {
    const a = t.page("Anouk")!, h = t.page("Home")!;
    return {
      actions: [
        { kind: "rewrite", page: a.id, base: a.revision_id, body: `${a.body}\nLikes tea.`, dropped: [] },
        { kind: "create", name: "Garden", type: "place", body: "Behind the house." },
        // The validator doesn't check aliases; the store refuses an alias that is another page's name.
        { kind: "rewrite", page: h.id, base: h.revision_id, aliases: ["Anouk"], body: h.body, dropped: [] },
      ],
      note: "three actions",
    };
  });
  await seedFixture(t.h, fixture("fold-notes"));
  const before = t.page("Anouk")!.body;
  const r = await t.run();
  assert.equal(r.row.outcome, "partial");
  assert.match(String(r.row.error), /refused twice: applying the plan failed: already used by another page: Anouk/);
  assert.equal(t.page("Anouk")!.body, before);
  assert.equal(t.page("Garden"), undefined);
  assert.equal(t.requests.length, 2, "one repair round");
});

test("a refused plan gets one repair round; the repaired plan is applied", async () => {
  const t = await host((req, n) => {
    const h = t.page("Home")!;
    return {
      actions: [{ kind: "rewrite", page: h.id, base: h.revision_id, body: "The boiler is in the attic.", dropped: n === 1 ? [] : [{ line: "Wifi password is on the router label.", reason: "the router was replaced" }] }],
      note: "tidied Home",
    };
  });
  await seedFixture(t.h, fixture("fold-notes"));
  const r = await t.run();
  assert.equal(r.outcome, "ok");
  assert.equal(r.row.outcome, "ok");
  const repair = t.requests[1]!.messages!;
  assert.deepEqual(repair.map((m) => m.role), ["user", "model", "user"]);
  assert.match(repair[2]!.text, /The plan was refused, and nothing was changed:\n- action 1 \(rewrite\): Home loses the line "Wifi password is on the router label\."/);
  assert.equal(t.page("Home")!.body, "The boiler is in the attic.");
  assert.deepEqual(JSON.parse(r.row.dropped_json as string).map((d: { page: string; line: string }) => [d.page, d.line]), [["Home", "Wifi password is on the router label."]]);
  assert.match(r.summary!, /1 page rewritten, 0 merges, 1 line dropped/);
});

test("a plan refused twice writes nothing, the run is partial with the reasons, and the pages are considered again", async () => {
  const t = await host(() => {
    const h = t.page("Home")!;
    return { actions: [{ kind: "rewrite", page: h.id, base: h.revision_id, body: "The boiler is in the attic.", dropped: [] }], note: "" };
  });
  await seedFixture(t.h, fixture("fold-notes"));
  const r = await t.run();
  assert.equal(r.row.outcome, "partial");
  assert.match(String(r.row.error), /consolidation plan refused twice: action 1 \(rewrite\): Home loses the line "Wifi password is on the router label\."/);
  assert.match(t.page("Home")!.body as string, /Wifi password/);
  await t.run();
  assert.equal(t.requests.length, 4, "tried again on the next run");
});

test("the fixture plans apply: notes folded with a declared drop, detail moved off an over-budget profile", async () => {
  for (const name of ["fold-notes", "profile-over-budget"]) {
    const f = fixture(name);
    const t = await host(() => fill(t.h, f.fake!.plan), f.env ?? {});
    await seedFixture(t.h, f);
    const r = await t.run();
    assert.equal(r.row.outcome, "ok", `${name}: ${r.row.error}`);
    const all = (t.h.db.prepare("SELECT body FROM brain__pages WHERE deleted_at IS NULL").all() as { body: string }[]).map((p) => p.body).join("\n");
    for (const k of f.mustKeep ?? []) assert.ok(all.includes(k), `${name} keeps ${k}`);
  }
});
