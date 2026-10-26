import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmRequest } from "@friday/sdk";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { summaryInput, validateSummary } from "../src/nightly/summary.js";
import { brainStore } from "./fixtures.js";
import { brainText, checkFixture, loadFixtures, seedFixture } from "./nightly/load.js";

type SummaryAnswer = (req: LlmRequest, n: number) => unknown;

/** A test host whose fake model notes nothing, plans nothing, and answers the summary with `summary`. */
async function host(summary: SummaryAnswer = () => ({ summary: "" }), env: Record<string, string> = {}) {
  const requests: LlmRequest[] = [];
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-30T01:00:00Z") }), {
    env,
    llm: async (req) => {
      const props = (req.schema as { properties?: Record<string, unknown> })?.properties;
      if (props?.notes) return JSON.stringify({ notes: [] });
      if (!props?.summary) return JSON.stringify({ actions: [], note: "tidy" });
      requests.push(req);
      const a = await summary(req, requests.length);
      return typeof a === "string" ? a : JSON.stringify(a);
    },
  });
  const profile = () => (h.request("GET", "pages/profile") as Promise<{ body: { body: string; instructions: string; revisionId: number; revisions: { author: string; note?: string }[] } }>).then((r) => r.body);
  const run = async () => {
    const r = await h.runJob("nightly");
    return { ...r, row: { ...(h.db.prepare("SELECT * FROM brain__runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>) } };
  };
  const meId = () => (h.db.prepare("SELECT subject_id AS id FROM brain__pages WHERE id = 'profile'").get() as { id: string }).id;
  const setMe = async (body: string) => {
    const cur = (await h.request("GET", `pages/${meId()}`)).body as { name: string; revisionId: number };
    await h.request("PUT", `pages/${meId()}`, { name: cur.name, type: "person", aliases: [], body, baseRevision: cur.revisionId });
  };
  return { h, requests, profile, run, setMe };
}

test("the summary is generated after the pages change, as a consolidation revision that keeps the instructions", async () => {
  const t = await host((_req, n) => ({ summary: n === 1 ? "Lives at Home in Almere.\nHobbies: RC racing." : "Lives at Home in Almere.\nHobbies: RC racing, with an Xray X4 touring car." }));
  await t.h.request("POST", "pages", { name: "Home", type: "place", body: "The house in Almere." });
  await t.h.request("POST", "pages", { name: "RC racing", type: "other", body: "Races 1:10 RC cars in summer." });
  await t.setMe("Lives at [[Home]]. Hobbies: [[RC racing]].");
  const opened = await t.profile();
  await t.h.request("PUT", "pages/profile", { instructions: "Call me Ray.", baseRevision: opened.revisionId });
  const first = await t.run();
  assert.equal(first.row.outcome, "ok", String(first.row.error));
  assert.equal(first.row.summary_generated, 1);
  assert.match(String(first.row.summary), /; summary generated$/);
  let p = await t.profile();
  // Mentions of pages are linked when the summary is written.
  assert.equal(p.body, "Lives at [[Home]] in Almere.\nHobbies: [[RC racing]].");
  assert.equal(p.instructions, "Call me Ray.");
  assert.deepEqual([p.revisions[0]!.author, p.revisions[0]!.note], ["consolidation", "generated from the pages"]);
  // The request: the guidance, the budget, the user's page first, the current summary.
  const req = t.requests[0]!;
  assert.match(req.system!, /## The profile summary/);
  assert.match(req.messages![0]!.text, /^Profile budget: at most 800 tokens/);
  assert.match(req.messages![0]!.text, /## Pages\n\n### Me \(person; the user's own page\)\nLives at \[\[Home\]\]/);
  assert.match(req.messages![0]!.text, /## The current summary\n\(none yet\)/);

  // A new note on a page makes the next run write the summary again.
  await t.h.call("brain_remember", { entity: "RC racing", fact: "Races an Xray X4 touring car in summer" });
  await t.run();
  assert.equal(t.requests.length, 2);
  p = await t.profile();
  assert.equal(p.body, "Lives at [[Home]] in Almere.\nHobbies: [[RC racing]], with an Xray X4 touring car.");
  assert.equal(p.instructions, "Call me Ray.");
  assert.match(t.requests[1]!.messages![0]!.text, /## The current summary\nLives at \[\[Home\]\] in Almere\./);
});

test("no model call for the summary when nothing changed since the last one; an instructions edit is no change", async () => {
  const t = await host(() => ({ summary: "Lives in Almere." }));
  await t.setMe("Lives in Almere.");
  await t.run();
  assert.equal(t.requests.length, 1);
  const p = await t.profile();
  await t.h.request("PUT", "pages/profile", { instructions: "Call me Ray.", baseRevision: p.revisionId });
  const second = await t.run();
  assert.equal(t.requests.length, 1);
  assert.equal(second.row.summary_generated, 0);
  assert.doesNotMatch(String(second.row.summary), /summary/);
});

test("an empty brain gets an empty summary without a model call", async () => {
  const t = await host();
  const r = await t.run();
  assert.equal(t.requests.length, 0);
  assert.equal(r.row.outcome, "ok");
  assert.equal((await t.profile()).body, "");
});

test("a refused summary gets one repair round; refused twice leaves the summary as it was, the run partial, and tries again", async () => {
  let answers = [{ summary: "Has a dog called Max." }, { summary: "Lives in Almere." }];
  const t = await host((_req, n) => answers[(n - 1) % 2]);
  await t.setMe("Lives in Almere.");
  const repaired = await t.run();
  assert.equal(repaired.row.outcome, "ok");
  assert.equal(t.requests.length, 2);
  assert.match(t.requests[1]!.messages![2]!.text, /The summary was refused[^]*the line "Has a dog called Max\." is not stated on Me or the pages it names/);
  assert.equal((await t.profile()).body, "Lives in Almere.");

  answers = [{ summary: "Has a dog called Max." }, { summary: "Has a dog called Max. Also [[Airsoft]]." }];
  await t.setMe("Lives in Almere. Works from home.");
  const refused = await t.run();
  assert.equal(refused.row.outcome, "partial");
  assert.match(String(refused.row.error), /summary refused twice: .*Has a dog called Max/);
  assert.match(String(refused.row.summary), /summary not generated/);
  assert.equal((await t.profile()).body, "Lives in Almere.", "the old summary stays");
  answers = [{ summary: "Lives in Almere, works from home." }, { summary: "" }];
  const again = await t.run();
  assert.equal(again.row.outcome, "ok");
  assert.equal((await t.profile()).body, "Lives in Almere, works from home.");
});

test("validation: within budget, links to live pages, every line backed by the user's page or the pages it names", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.save(store.subjectId(), { name: "Me", type: "person", aliases: [], body: "Prefers the home at 20.5 °C. Wakes up around 07:30 on weekdays." }, "user");
  store.create({ name: "Dimitri", type: "person", body: "The user's brother." }, "user");
  store.create({ name: "Motorcycles", type: "other", body: "Owns a customized Suzuki Bandit and a 1979 Honda CB900F." }, "user");
  const ok = "Prefers the home at 20.5 °C.\nBrother: [[Dimitri]].\nRides [[Motorcycles]]: a Suzuki Bandit and a 1979 Honda CB900F.\n\n## Routine\n- Up around 07:30 on weekdays.";
  assert.deepEqual(validateSummary(store, ok, 800), []);
  // A name without brackets counts as naming the page too.
  assert.deepEqual(validateSummary(store, "Motorcycles: a Suzuki Bandit.", 800), []);
  assert.match(validateSummary(store, "Has a dog called Max.", 800).join("\n"), /the line "Has a dog called Max\." is not stated on Me or the pages it names/);
  // Words on a page the line doesn't name don't back it.
  assert.match(validateSummary(store, "Brother: [[Dimitri]], rides a Suzuki Bandit.", 800).join("\n"), /is not stated/);
  assert.match(validateSummary(store, "Plays [[Airsoft]] sometimes.", 800).join("\n"), /\[\[Airsoft\]\] is not a page/);
  assert.match(validateSummary(store, "Prefers the home at 20.5 °C. ".repeat(20), 50).join("\n"), /the summary is about \d+ tokens; it must be at most 50/);
  assert.match(validateSummary(store, "See [[Profile]].", 800).join("\n"), /\[\[Profile\]\] is not a page/);
  assert.deepEqual(validateSummary(store, undefined, 800), ["the answer has no summary text"]);
});

test("the summary fixtures pass with their canned summaries: within budget, backed, linked", async () => {
  for (const f of loadFixtures().filter((x) => x.kind === "summary")) {
    const t = await host(() => ({ summary: f.fake!.summary }), f.env ?? {});
    await seedFixture(t.h, f);
    const before = brainText(t.h);
    const r = await t.run();
    assert.equal(r.row.outcome, "ok", `${f.name}: ${r.row.error}`);
    for (const c of checkFixture(t.h, f, before)) assert.ok(c.ok, `${f.name}: ${c.expectation}`);
  }
  // The checks catch a bad summary, too.
  const f = loadFixtures().find((x) => x.name === "summary-over-budget")!;
  const t = await host(() => ({ summary: "Engineer at Schuberg Philis." }), f.env ?? {});
  await seedFixture(t.h, f);
  await t.run();
  assert.deepEqual(checkFixture(t.h, f, "").filter((c) => !c.ok).map((c) => c.expectation), ["the summary links [[Motorcycles]]", "the summary links [[RC racing]]"]);
});

test("the input puts the user's page and the home page first, then the user's neighbours, with an index beyond the bound", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.create({ name: "Home", type: "place", body: "The house in Almere." }, "user");
  store.create({ name: "Dimitri", type: "person", body: "Brother." }, "user");
  for (let i = 0; i < 5; i++) store.create({ name: `Filler ${i}`, body: "x".repeat(3000) }, "user");
  store.save(store.subjectId(), { name: "Me", type: "person", aliases: [], body: "Brother: [[Dimitri]]." }, "user");
  store.writeSummary("Brother: Dimitri.", "consolidation");
  const text = summaryInput(store, 800, 5000);
  assert.match(text, /^Profile budget: at most 800 tokens/);
  assert.match(text, /## Pages\n\n### Me \(person; the user's own page\)\nBrother: \[\[Dimitri\]\]\.\n\n### Home \(place\)\nThe house in Almere\.\n\n### Dimitri \(person\)\nBrother\./);
  assert.match(text, /## Other pages \(index only\)\n- Filler/);
  assert.match(text, /## The current summary\nBrother: \[\[Dimitri\]\]\.$/);
  assert.doesNotMatch(text, /### Profile/);
});
