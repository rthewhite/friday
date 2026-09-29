import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";

/**
 * One run over a seeded brain: extraction notes a fact on Anouk from conversation c1, then consolidation
 * merges Noukie into Anouk (folding the note), rewrites Home and creates Garden.
 */
async function scene() {
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-30T01:00:00Z") }), {
    llm: (req) => {
      if ((req.schema as { properties?: Record<string, unknown> }).properties?.notes) {
        return JSON.stringify({ notes: [{ entity: "Anouk", fact: "Birthday is 3 November.", reason: "stated" }] });
      }
      const p = (n: string) => h.db.prepare("SELECT p.id, p.revision_id AS rev, p.body FROM brain__names k JOIN brain__pages p ON p.id = k.page_id WHERE k.key = ?").get(n) as { id: string; rev: number; body: string };
      const anouk = p("anouk"), noukie = p("noukie"), home = p("home");
      return JSON.stringify({
        actions: [
          { kind: "merge", from: noukie.id, into: anouk.id, fromBase: noukie.rev, intoBase: anouk.rev, body: "My sister, lives in Utrecht. Birthday: 3 November. Likes tea.", dropped: [] },
          { kind: "rewrite", page: home.id, base: home.rev, body: "The boiler is in the attic.", dropped: [{ line: "Wifi password is on the router label.", reason: "new router has no label" }] },
          { kind: "create", name: "Garden", type: "place", body: "Behind the house, with an apple tree." },
        ],
        note: "Merged Noukie into Anouk; tidied Home.",
      });
    },
  });
  const post = async (b: object) => (await h.request("POST", "pages", b)).body as { id: string };
  const anouk = await post({ name: "Anouk", type: "person", body: "My sister, lives in Utrecht." });
  const noukie = await post({ name: "Noukie", type: "person", body: "Likes tea." });
  const home = await post({ name: "Home", type: "place", body: "Wifi password is on the router label.\nThe boiler is in the attic." });
  h.conversations.seed({ id: "c1", channel: "chat", lastActivityAt: "2026-09-29T18:00:00Z", quietAt: "2026-09-29T18:30:00Z", entries: [{ kind: "user", input: "text", text: "Anouk's birthday is on the third of November" }] });
  const job = await h.runJob("nightly");
  assert.equal(job.outcome, "ok", job.error);
  const runs = (await h.request("GET", "runs")).body as { runs: { id: number; summary: string }[] };
  const run = runs.runs[0]!;
  const review = async () => (await h.request("GET", `runs/${run.id}`)).body as { run: unknown; pages: any[] };
  const page = async (id: string) => (await h.request("GET", `pages/${id}`)).body as { name: string; body: string; aliases: string[]; revisionId: number; deletedAt?: string };
  return { h, run, review, page, ids: { anouk: anouk.id, noukie: noukie.id, home: home.id } };
}

test("GET runs lists runs newest first with their summary", async () => {
  const { h, run } = await scene();
  assert.equal(run.summary, "1 conversation (0 trivial), 1 note; 1 page rewritten, 1 page created, 1 merge, 1 line dropped");
  await h.runJob("nightly");
  const runs = ((await h.request("GET", "runs?limit=1")).body as { runs: { id: number }[] }).runs;
  assert.deepEqual(runs.map((r) => r.id), [run.id + 1]);
});

test("GET runs/:id shows each touched page with before and after, dropped lines, merges and sources", async () => {
  const { review, ids } = await scene();
  const { pages } = await review();
  const by = (id: string) => pages.find((p) => p.pageId === id);
  const anouk = by(ids.anouk);
  assert.equal(anouk.before.body, "My sister, lives in Utrecht.");
  assert.equal(anouk.after.body, "My sister, lives in Utrecht. Birthday: 3 November. Likes tea.");
  assert.deepEqual(anouk.authors, ["extraction", "consolidation"]);
  assert.deepEqual(anouk.sources, [{ id: "c1", exists: true }]);
  assert.equal(anouk.mergedFrom, ids.noukie);
  assert.equal(anouk.changedSince, false);
  const noukie = by(ids.noukie);
  assert.equal(noukie.mergedInto, ids.anouk);
  assert.equal(noukie.deleted, true);
  const home = by(ids.home);
  assert.deepEqual(home.dropped.map((d: { line: string; reason: string }) => [d.line, d.reason]), [["Wifi password is on the router label.", "new router has no label"]]);
  const garden = pages.find((p) => p.name === "Garden");
  assert.equal(garden.before, undefined);
  assert.deepEqual(garden.authors, ["consolidation"]);
});

test("reverting a rewrite restores the pre-run revision as a user revision", async () => {
  const { h, run, review, page, ids } = await scene();
  const home = await page(ids.home);
  const r = await h.request("POST", `runs/${run.id}/pages/${ids.home}/revert`, { base: home.revisionId });
  assert.deepEqual(r, { status: 200, body: { reverted: ["Home"] }, contentType: "application/json" });
  const after = await page(ids.home);
  assert.equal(after.body, "Wifi password is on the router label.\nThe boiler is in the attic.");
  const revs = ((await h.request("GET", `pages/${ids.home}`)).body as { revisions: { author: string; note?: string }[] }).revisions;
  assert.deepEqual(revs[0], { ...revs[0], author: "user", note: `reverted nightly run ${run.id}` });
  assert.equal((await review()).pages.find((p) => p.pageId === ids.home).changedSince, true);
});

test("reverting a merge restores the target and brings the absorbed page back", async () => {
  const { h, run, page, ids } = await scene();
  const anouk = await page(ids.anouk);
  assert.deepEqual(anouk.aliases, ["Noukie"]);
  const r = await h.request("POST", `runs/${run.id}/pages/${ids.anouk}/revert`, { base: anouk.revisionId });
  assert.deepEqual(r.body, { reverted: ["Anouk", "Noukie"] });
  assert.equal((await page(ids.anouk)).body, "My sister, lives in Utrecht.");
  assert.deepEqual((await page(ids.anouk)).aliases, []);
  const noukie = await page(ids.noukie);
  assert.equal(noukie.deletedAt, undefined);
  assert.equal(noukie.body, "Likes tea.");
});

test("reverting a page the run created deletes it", async () => {
  const { h, run, review } = await scene();
  const garden = (await review()).pages.find((p) => p.name === "Garden");
  const r = await h.request("POST", `runs/${run.id}/pages/${garden.pageId}/revert`, { base: garden.currentRevisionId });
  assert.deepEqual(r.body, { reverted: ["Garden"] });
  assert.ok(((await h.request("GET", `pages/${garden.pageId}`)).body as { deletedAt?: string }).deletedAt);
});

test("a page someone else wrote during the run counts as changed, so revert doesn't erase that write", async () => {
  let remembered = false;
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-30T01:00:00Z") }), {
    llm: async (req) => {
      if ((req.schema as { properties?: Record<string, unknown> }).properties?.notes) return JSON.stringify({ notes: [] });
      if (!remembered) {
        remembered = true;
        // The user asks Friday to remember something while the plan is being made.
        await h.call("brain_remember", { entity: "Home", fact: "The spare key is under the mat." });
      }
      const home = h.db.prepare("SELECT p.id, p.revision_id AS rev, p.body FROM brain__names k JOIN brain__pages p ON p.id = k.page_id WHERE k.key = 'home'").get() as { id: string; rev: number; body: string };
      return JSON.stringify({ actions: [{ kind: "rewrite", page: home.id, base: home.rev, body: "The boiler is in the attic. The spare key is under the mat.", dropped: [] }], note: "tidied Home" });
    },
  });
  const home = (await h.request("POST", "pages", { name: "Home", type: "place", body: "The boiler is in the attic." })).body as { id: string };
  assert.equal((await h.runJob("nightly")).outcome, "ok");
  const runId = ((await h.request("GET", "runs")).body as { runs: { id: number }[] }).runs[0]!.id;
  const page = ((await h.request("GET", `runs/${runId}`)).body as { pages: { pageId: string; changedSince: boolean; currentRevisionId: number }[] }).pages.find((p) => p.pageId === home.id)!;
  assert.equal(page.changedSince, true);
  const r = await h.request("POST", `runs/${runId}/pages/${home.id}/revert`, { base: page.currentRevisionId });
  assert.equal(r.status, 409);
  assert.match(((await h.request("GET", `pages/${home.id}`)).body as { body: string }).body, /spare key/);
});

test("a page changed after the run is refused as stale, and a deleted source is marked gone", async () => {
  const { h, run, review, page, ids } = await scene();
  const home = await page(ids.home);
  await h.request("PUT", `pages/${ids.home}`, { name: "Home", type: "place", aliases: [], body: "Edited by hand.", baseRevision: home.revisionId });
  const r = await h.request("POST", `runs/${run.id}/pages/${ids.home}/revert`, { base: home.revisionId });
  assert.equal(r.status, 409);
  assert.equal((r.body as { code: string }).code, "stale");
  assert.equal((await page(ids.home)).body, "Edited by hand.");
  // Retention deleted the source conversation.
  (h.conversations as unknown as { items: Map<string, unknown> }).items.delete("c1");
  assert.deepEqual((await review()).pages.find((p) => p.pageId === ids.anouk).sources, [{ id: "c1", exists: false }]);
  assert.equal((await h.request("GET", "runs/999")).status, 404);
  assert.equal((await h.request("POST", `runs/${run.id}/pages/nope/revert`, { base: 1 })).status, 404);
});
