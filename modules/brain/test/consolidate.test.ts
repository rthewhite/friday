import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmRequest } from "@friday/sdk";
import { createTestHost, type TestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { preserved, renderConsolidation, validatePlan, type Plan } from "../src/nightly/consolidate.js";
import { GUIDANCE_VERSION } from "../src/nightly/guidance.js";
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
    llm: async (req) => {
      if ((req.schema as { properties?: Record<string, unknown> })?.properties?.notes) return JSON.stringify({ notes: [] });
      requests.push(req);
      const a = await plan(req, requests.length);
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

// ---- profile-as-summary 2.1 guidance version ----

const GUIDANCE = "consolidate:guidance";

test("an older guidance version reconsiders the profile once, even when no page changed", async () => {
  const t = await host();
  await seedFixture(t.h, fixture("fold-notes"));
  await t.run();
  assert.equal(t.requests.length, 1);
  assert.equal(await t.h.storage.get(GUIDANCE), GUIDANCE_VERSION, "an applied plan, even an empty one, records the guidance");
  // As on an install whose brain was last consolidated under the previous guidance.
  await t.h.storage.set(GUIDANCE, GUIDANCE_VERSION - 1);
  await t.run();
  assert.equal(t.requests.length, 2, "the model is called although no page changed");
  const p = t.requests[1]!.messages![0]!.text;
  assert.match(p, /### Profile \[id profile, revision \d+\] \(changed\)/);
  assert.match(p, /The guidance changed since the last tidy-up; check the profile against it\./);
  assert.doesNotMatch(p, /### Anouk \[id [^\]]+\] \(changed\)/, "only the profile counts as changed");
  const third = await t.run();
  assert.equal(t.requests.length, 2, "once the plan is applied the guidance counts as handled");
  assert.match(third.summary!, /nothing to consolidate/);
});

test("without an older guidance version the input has no guidance line", async () => {
  const t = await host();
  await seedFixture(t.h, fixture("fold-notes"));
  await t.h.storage.set(GUIDANCE, GUIDANCE_VERSION);
  await t.run();
  assert.doesNotMatch(t.requests[0]!.messages![0]!.text, /guidance changed/);
});

test("a guidance change whose plans are refused twice is tried again on the next run", async () => {
  let refuse = false;
  const t = await host(() => {
    if (!refuse) return { actions: [], note: "" };
    const p = t.page("Profile")!;
    return { actions: [{ kind: "rewrite", page: p.id, base: p.revision_id, body: "Lives in Utrecht.", dropped: [] }], note: "" };
  });
  await seedFixture(t.h, { ...fixture("fold-notes"), profile: "Lives in Amsterdam with two cats." });
  await t.run();
  await t.h.storage.set(GUIDANCE, GUIDANCE_VERSION - 1);
  refuse = true;
  const r = await t.run();
  assert.equal(r.row.outcome, "partial");
  assert.equal(t.requests.length, 3);
  assert.equal(await t.h.storage.get(GUIDANCE), GUIDANCE_VERSION - 1, "nothing applied, so the guidance is not handled");
  await t.run();
  assert.equal(t.requests.length, 5, "tried again on the next run");
});

test("an empty brain records the guidance without a model call", async () => {
  const t = await host();
  const r = await t.run();
  assert.equal(t.requests.length, 0);
  assert.match(r.summary!, /nothing to consolidate/);
  assert.equal(await t.h.storage.get(GUIDANCE), GUIDANCE_VERSION);
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
  assert.match(reasonsFor(store, { actions: [{ kind: "merge", from: noukie.id, into: profile.id, fromBase: noukie.revisionId, intoBase: profile.revisionId, body: "Also Anouk?" }], note: "" }), /the profile can't be merged/);
  const job = store.create({ name: "Old job" }, "user");
  store.softDelete(job.id, "user");
  store.purge(job.id, "Old job", "user");
  assert.match(reasonsFor(store, { actions: [{ kind: "create", name: "old job", type: "project", body: "back" }], note: "" }), /"old job" was deliberately forgotten/);
  assert.match(reasonsFor(store, { actions: [{ kind: "rewrite", page: noukie.id, base: noukie.revisionId, name: "Anouk", body: "Also Anouk?" }], note: "" }), /the name "Anouk" is already used by Anouk/);
  // A name freed by a merge in the same plan is fine.
  assert.equal(reasonsFor(store, {
    actions: [
      { kind: "merge", from: noukie.id, into: anouk.id, fromBase: noukie.revisionId, intoBase: anouk.revisionId, body: "My sister. Moved to Utrecht. Also Anouk?", dropped: [{ line: "My sister. Lives in Amsterdam.", reason: "moved" }] },
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

// ---- profile-as-summary 2.2 the loss check sees the pages a line names ----

function household() {
  const s = brainStore();
  const profile = s.store.save("profile", { name: "Profile", type: "other", aliases: [], body: "Engineer.\nMy wife [[Lisa]] teaches at De Regenboog.\nMy brother Mark plays the cello in an orchestra." }, "user");
  const lisa = s.store.create({ name: "Lisa", type: "person", body: "The user's wife. Teaches at De Regenboog." }, "user");
  const mark = s.store.create({ name: "Mark", type: "person", aliases: ["Markie"], body: "The user's brother." }, "user");
  const tennis = s.store.create({ name: "Tennis club", type: "place", body: "Mark's orchestra plays the cello concerts there." }, "user");
  return { ...s, profile, lisa, mark, tennis };
}
const trimProfile = (p: { id: string; revisionId: number }, body: string): Plan => ({ actions: [{ kind: "rewrite", page: p.id, base: p.revisionId, body, dropped: [] }], note: "" });

test("a line removed from the profile counts as kept when the page it links to states it", (t) => {
  const { store, close, profile } = household();
  t.after(close);
  const r = reasonsFor(store, trimProfile(profile, "Engineer.\nWife: [[Lisa]].\nMy brother Mark plays the cello in an orchestra."));
  assert.equal(r, "");
});

test("a line removed from the profile is refused when the page it names doesn't state it", (t) => {
  const { store, close, profile, lisa } = household();
  t.after(close);
  store.save(lisa.id, { name: "Lisa", type: "person", aliases: [], body: "The user's wife." }, "user");
  const fresh = store.profile();
  assert.match(reasonsFor(store, trimProfile(fresh, "Engineer.\nWife: [[Lisa]].\nMy brother Mark plays the cello in an orchestra.")), /Profile loses the line "My wife \[\[Lisa\]\] teaches at De Regenboog\." without declaring it in dropped/);
});

test("a name without a link counts too, but a line naming no page, or only an unrelated page with its words, is refused", (t) => {
  const { store, close, profile, mark } = household();
  t.after(close);
  // "Markie" is an alias of Mark, named as a whole word; Mark's page then states the fact.
  store.save(mark.id, { name: "Mark", type: "person", aliases: ["Markie"], body: "The user's brother. Plays the cello in an orchestra." }, "user");
  let p = store.profile();
  store.save(p.id, { name: "Profile", type: "other", aliases: [], body: "Engineer.\nMy wife [[Lisa]] teaches at De Regenboog.\nMy brother Markie plays the cello in an orchestra." }, "user");
  p = store.profile();
  assert.equal(reasonsFor(store, trimProfile(p, "Engineer.\nMy wife [[Lisa]] teaches at De Regenboog.\nBrother: [[Mark]].")), "");
  // "Engineer." names no page: it is still lost.
  assert.match(reasonsFor(store, trimProfile(p, "My wife [[Lisa]] teaches at De Regenboog.\nMy brother Markie plays the cello in an orchestra.")), /Profile loses the line "Engineer\."/);
  // The words are on "Tennis club", which the line doesn't name, and Mark's page (named) no longer states them.
  store.save(mark.id, { name: "Mark", type: "person", aliases: ["Markie"], body: "The user's brother." }, "user");
  p = store.profile();
  assert.match(reasonsFor(store, trimProfile(p, "Engineer.\nMy wife [[Lisa]] teaches at De Regenboog.\nBrother: [[Mark]].")), /Profile loses the line "My brother Markie plays the cello in an orchestra\."/);
  void profile;
});

test("a named page the plan rewrites is judged by its new body, not its old one", (t) => {
  const { store, close, profile, lisa } = household();
  t.after(close);
  const plan: Plan = {
    actions: [
      { kind: "rewrite", page: profile.id, base: profile.revisionId, body: "Engineer.\nWife: [[Lisa]].\nMy brother Mark plays the cello in an orchestra.", dropped: [] },
      { kind: "rewrite", page: lisa.id, base: lisa.revisionId, body: "The user's wife.", dropped: [{ line: "The user's wife. Teaches at De Regenboog.", reason: "test" }] },
    ],
    note: "",
  };
  assert.match(reasonsFor(store, plan), /Profile loses the line "My wife \[\[Lisa\]\] teaches at De Regenboog\."/);
});

test("a plan of more than 20 actions is refused (the schema can't cap it: Gemini rejects maxItems there)", (t) => {
  const { store, close } = scene();
  t.after(close);
  const actions = Array.from({ length: 21 }, (_, i) => ({ kind: "create" as const, name: `Page ${i}`, body: "x" }));
  assert.match(reasonsFor(store, { actions, note: "" }), /the plan has 21 actions; at most 20/);
  assert.equal(reasonsFor(store, { actions: actions.slice(0, 20), note: "" }), "");
});

test("a page may appear in only one action", (t) => {
  const { store, close, anouk, noukie } = scene();
  t.after(close);
  const r = reasonsFor(store, {
    actions: [
      { kind: "rewrite", page: anouk.id, base: anouk.revisionId, body: "My sister. Lives in Amsterdam.\nMoved to Utrecht." },
      { kind: "merge", from: noukie.id, into: anouk.id, fromBase: noukie.revisionId, intoBase: anouk.revisionId, body: "My sister. Lives in Amsterdam. Moved to Utrecht. Also Anouk?" },
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

test("a page written while the model thinks is still consolidated on the next run", async () => {
  const t = await host(async (_req, n) => {
    if (n === 1) {
      // brain_remember appends to Car during the (slow) model call.
      const car = t.page("Car")!;
      await t.h.request("PUT", `pages/${car.id}`, { name: "Car", type: "other", aliases: [], body: `${car.body}\n## Notes\n- 2026-09-30: APK in March`, baseRevision: car.revision_id });
    }
    return { actions: [], note: "tidy" };
  });
  await t.h.request("POST", "pages", { name: "Anouk", body: "Sister" });
  await t.h.request("POST", "pages", { name: "Car", body: "Blue Volvo" });
  await t.run();
  await t.run();
  assert.equal(t.requests.length, 2, "Car's new note makes the next run look again");
  assert.match(t.requests[1]!.messages![0]!.text, /### Car \[[^\]]+\] \(changed\)/);
});

test("changed pages beyond the bound stay pending, and only pages shown in full may be changed", async () => {
  const t = await host();
  for (let i = 0; i < 5; i++) await t.h.request("POST", "pages", { name: `Big ${i}`, body: `${i} ${"lorem ipsum dolor ".repeat(850)}` });
  await t.run();
  const first = t.requests[0]!.messages![0]!.text;
  assert.match(first, /## Other pages \(index only, not in full\)/);
  await t.run();
  assert.equal(t.requests.length, 2, "the pages that were only indexed are considered again");

  const { store, close } = brainStore();
  try {
    const p = store.create({ name: "Hidden", body: "text" }, "user");
    assert.match(validatePlan(store, { actions: [{ kind: "rewrite", page: p.id, base: p.revisionId, body: "text!" }], note: "" }, 800, new Set()).join("\n"), /Hidden was only in the index, not shown in full/);
  } finally {
    close();
  }
});

test("the loss check matches whole words: a number or word hidden inside others doesn't count as kept", () => {
  assert.equal(preserved("- Anna has 2 cats", "Anna, 2026-09-29, scatsinger"), false);
  assert.equal(preserved("- 2026-09-29: Birthday is 3 November", "Birthdays: 3 November"), true);
  assert.equal(preserved("Verjaardag in mei", "verjaardagen: mei"), true);
});

test("a reverted page is not rewritten again on the next night", async () => {
  const t = await host((_req, n) => {
    const h = t.page("Home")!;
    return n === 1 ? { actions: [{ kind: "rewrite", page: h.id, base: h.revision_id, body: "The boiler is in the attic. The wifi password is on the router label.", dropped: [] }], note: "tidied" } : { actions: [], note: "" };
  });
  await seedFixture(t.h, fixture("fold-notes"));
  const r = await t.run();
  assert.equal(r.row.outcome, "ok");
  const home = t.page("Home")!;
  const revert = await t.h.request("POST", `runs/${r.row.id}/pages/${home.id}/revert`, { base: home.revision_id });
  assert.equal(revert.status, 200, JSON.stringify(revert.body));
  const again = await t.run();
  assert.equal(t.requests.length, 1, "no model call: the revert is not a change to consolidate");
  assert.match(again.summary!, /nothing to consolidate/);
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
