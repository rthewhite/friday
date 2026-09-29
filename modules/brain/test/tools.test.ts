import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule, localDate } from "../src/index.js";

/** A host whose clock is 29 September 2026, 10:00 in Amsterdam. */
async function host(env: Record<string, string> = {}) {
  let now = new Date("2026-09-29T08:00:00Z");
  const h = await createTestHost(createBrainModule({ now: () => now }), { env });
  const remember = async (args: Record<string, unknown>) => (await h.call("brain_remember", args)).result;
  const recall = async (args: Record<string, unknown>) => (await h.call("brain_recall", args)).result as any;
  const body = (name: string) => (h.db.prepare("SELECT body FROM brain__pages WHERE name = ? AND deleted_at IS NULL").get(name) as { body: string } | undefined)?.body;
  const pageCount = () => (h.db.prepare("SELECT count(*) AS n FROM brain__pages").get() as { n: number }).n;
  const put = async (path: string, b: unknown) => h.request("PUT", path, b);
  return { h, remember, recall, body, pageCount, put, setNow: (iso: string) => void (now = new Date(iso)) };
}

// ---- 4.1 brain_remember ----

test("remembering an unknown person creates a page with a dated note", async () => {
  const { h, remember, body } = await host();
  assert.deepEqual(await remember({ entity: "Anouk", fact: "Birthday is 3 November", type: "person" }), { stored: true, page: "Anouk", created: true });
  assert.equal(body("Anouk"), "## Notes\n- 2026-09-29: Birthday is 3 November");
  const row = h.db.prepare("SELECT type FROM brain__pages WHERE name = 'Anouk'").get() as { type: string };
  assert.equal(row.type, "person");
  const rev = h.db.prepare("SELECT author, sources_json FROM brain__revisions r JOIN brain__pages p ON p.id = r.page_id WHERE p.name = 'Anouk'").all().map((r) => ({ ...r }));
  assert.deepEqual(rev, [{ author: "remember", sources_json: "[]" }]);
});

test("the note date is local to FRIDAY_TIMEZONE", async () => {
  // 23:30 UTC on 28 September is already 29 September in Amsterdam, and still the 28th in New York.
  assert.equal(localDate(new Date("2026-09-28T23:30:00Z"), "Europe/Amsterdam"), "2026-09-29");
  const { remember, body, setNow } = await host({ FRIDAY_TIMEZONE: "America/New_York" });
  setNow("2026-09-29T02:00:00Z");
  await remember({ entity: "Bram", fact: "Has a cat" });
  assert.equal(body("Bram"), "## Notes\n- 2026-09-28: Has a cat");
});

test("an alias resolves to its page, and no page is created", async () => {
  const { h, remember, body, pageCount } = await host();
  await h.request("POST", "pages", { name: "Anouk", type: "person", aliases: ["Noukie"] });
  const before = pageCount();
  assert.deepEqual(await remember({ entity: "noukie", fact: "Lives in Utrecht" }), { stored: true, page: "Anouk", created: false });
  assert.equal(pageCount(), before);
  assert.equal(body("Anouk"), "## Notes\n- 2026-09-29: Lives in Utrecht");
});

test("existing text is untouched and notes are appended in order under the last Notes heading", async () => {
  const { h, remember, body, setNow } = await host();
  await h.request("POST", "pages", { name: "Anouk", type: "person", body: "Sister, the eldest.\n\n## Notes\n- 2026-01-02: Likes tea\n\n## Kids\n- Mila" });
  await remember({ entity: "Anouk", fact: "Moved to   Utrecht\nin  June" });
  setNow("2026-10-01T08:00:00Z");
  await remember({ entity: "Anouk", fact: "Started running" });
  assert.equal(body("Anouk"), "Sister, the eldest.\n\n## Notes\n- 2026-01-02: Likes tea\n- 2026-09-29: Moved to Utrecht in June\n- 2026-10-01: Started running\n\n## Kids\n- Mila");
  // Without a Notes section one is added at the end.
  await h.request("POST", "pages", { name: "Car", body: "Blue Volvo\n" });
  await remember({ entity: "car", fact: "APK in March" });
  assert.equal(body("Car"), "Blue Volvo\n\n## Notes\n- 2026-10-01: APK in March");
});

test("a fact already on the page is not written again", async () => {
  const { h, remember } = await host();
  await remember({ entity: "Anouk", fact: "Birthday is 3 November" });
  const revisions = () => (h.db.prepare("SELECT count(*) AS n FROM brain__revisions").get() as { n: number }).n;
  const before = revisions();
  const r = await remember({ entity: "anouk", fact: "birthday is 3 november" });
  assert.deepEqual(r, { stored: false, reason: "already_known", page: "Anouk", message: "Anouk already has this fact" });
  assert.equal(revisions(), before);
});

test("a correction back to an older fact is stored as the newest note; same-day repeats are skipped", async () => {
  const { remember, body, setNow } = await host();
  setNow("2025-01-10T08:00:00Z");
  await remember({ entity: "Home", fact: "Lives in Utrecht" });
  setNow("2026-03-01T08:00:00Z");
  await remember({ entity: "Home", fact: "Lives in Amsterdam" });
  setNow("2026-09-29T08:00:00Z");
  // Moving back: the older note says the same, but it isn't the latest one.
  assert.deepEqual(await remember({ entity: "Home", fact: "Lives in Utrecht" }), { stored: true, page: "Home", created: false });
  await remember({ entity: "Home", fact: "Has a garden" });
  // Said twice in one conversation: the same-day note counts even when it isn't the latest.
  assert.equal((await remember({ entity: "Home", fact: "lives in  utrecht" })).reason, "already_known");
  assert.equal(body("Home"), "## Notes\n- 2025-01-10: Lives in Utrecht\n- 2026-03-01: Lives in Amsterdam\n- 2026-09-29: Lives in Utrecht\n- 2026-09-29: Has a garden");
});

test("a fact mentioned in the page's own text, or inside a longer note, is still noted", async () => {
  const { h, remember, body } = await host();
  await h.request("POST", "pages", { name: "Anouk", body: "She likes coffee a lot.\n\n## Notes\n- 2026-01-01: Dislikes coffee in the evening" });
  assert.equal((await remember({ entity: "Anouk", fact: "likes coffee" })).stored, true);
  assert.match(body("Anouk")!, /- 2026-09-29: likes coffee$/);
});

test("entity profile appends to the profile, whatever its budget", async () => {
  const { remember, body } = await host({ BRAIN_PROFILE_TOKEN_BUDGET: "5" });
  assert.deepEqual(await remember({ entity: "Profile", fact: "Prefers Celsius" }), { stored: true, page: "Profile", created: false });
  assert.deepEqual(await remember({ entity: "profile", fact: "Has two cats and a very long list of other lasting preferences" }), { stored: true, page: "Profile", created: false });
  assert.equal(body("Profile"), "## Notes\n- 2026-09-29: Prefers Celsius\n- 2026-09-29: Has two cats and a very long list of other lasting preferences");
});

test("a tombstoned entity is refused as deliberately forgotten", async () => {
  const { h, remember, pageCount } = await host();
  const { body: page } = await h.request("POST", "pages", { name: "Old job" });
  const id = (page as { id: string }).id;
  await h.request("DELETE", `pages/${id}`);
  await h.request("POST", `pages/${id}/purge`, { confirm: "Old job" });
  const before = pageCount();
  assert.deepEqual(await remember({ entity: "Old job", fact: "Boss was Kees" }), {
    stored: false,
    reason: "tombstoned",
    message: "this was deliberately forgotten; the user can recreate it in the portal",
  });
  assert.equal(pageCount(), before);
  // Recreated by the user, it takes notes again.
  await h.request("POST", "pages", { name: "Old job" });
  assert.deepEqual(await remember({ entity: "Old job", fact: "Boss was Kees" }), { stored: true, page: "Old job", created: false });
});

test("an empty, over-long or badly named fact is refused", async () => {
  const { remember, pageCount } = await host();
  const before = pageCount();
  assert.deepEqual(await remember({ entity: "Anouk", fact: "   \n " }), { stored: false, reason: "invalid", message: "the fact is empty" });
  assert.match(String(((await remember({ entity: "Anouk", fact: "x".repeat(501) })) as { message: string }).message), /at most 500 characters/);
  assert.equal((await remember({ entity: "Anouk", fact: "x".repeat(500) })).stored, true);
  assert.equal((await remember({ entity: "[[Bad]]", fact: "ok" })).reason, "invalid");
  assert.equal((await remember({ entity: "Cat", fact: "ok", type: "animal" })).reason, "invalid");
  assert.equal(pageCount(), before + 1);
});

// ---- 4.2 brain_recall ----

async function seeded() {
  const t = await host();
  const post = async (b: Record<string, unknown>) => (await t.h.request("POST", "pages", b)).body as { id: string };
  await post({ name: "Anouk", type: "person", aliases: ["Noukie"], body: "Sister. Birthday 3 November.\nLinks to [[Utrecht]] and [[Nowhere]]." });
  await post({ name: "Family", body: "- Sister: [[Anouk]], birthday party in November" });
  await post({ name: "Home", type: "place", body: "Wifi password is on the router label" });
  await post({ name: "Utrecht", type: "place", body: "City" });
  await t.put("pages/profile", { name: "Profile", type: "other", aliases: [], body: "Birthday in May", baseRevision: 1 });
  return t;
}

test("recall returns the named page first, then search hits, with connections", async () => {
  const { recall } = await seeded();
  const r = await recall({ entity: "Anouk", query: "Anouk birthday" });
  assert.equal(r.found, true);
  assert.deepEqual(r.pages.map((p: any) => [p.name, p.found_by]), [["Anouk", "name+search"], ["Family", "search"]]);
  assert.deepEqual(Object.keys(r.pages[0]).sort(), ["aliases", "body", "found_by", "name", "type", "updatedAt"]);
  assert.deepEqual(r.pages[0].aliases, ["Noukie"]);
  // Outgoing links first (resolved and dangling), then backlinks.
  assert.deepEqual(r.connections, [
    { from: "Anouk", to: "Utrecht", line: "Links to [[Utrecht]] and [[Nowhere]].", exists: true },
    { from: "Anouk", to: "Nowhere", line: "Links to [[Utrecht]] and [[Nowhere]].", exists: false },
    { from: "Family", to: "Anouk", line: "- Sister: [[Anouk]], birthday party in November", exists: true },
  ]);
});

test("recall resolves the entity through an alias; found_by says how each page matched", async () => {
  const { h, recall } = await seeded();
  // The entity's words are search terms too, so a matched alias also counts as a search hit.
  assert.deepEqual((await recall({ entity: "noukie", query: "something unrelated" })).pages.map((p: any) => [p.name, p.found_by]), [["Anouk", "name+search"]]);
  // A two-letter name is no search term: found by name only.
  await h.request("POST", "pages", { name: "Bo", type: "person", body: "Neighbour" });
  assert.deepEqual((await recall({ entity: "bo", query: "zzz" })).pages.map((p: any) => [p.name, p.found_by]), [["Bo", "name"]]);
});

test("a topic search finds a fact filed elsewhere and never returns the profile", async () => {
  const { recall } = await seeded();
  assert.deepEqual((await recall({ query: "wifi password" })).pages.map((p: any) => p.name), ["Home"]);
  const birthday = await recall({ query: "birthday" });
  assert.ok(!birthday.pages.some((p: any) => p.name === "Profile"));
  assert.ok(birthday.pages.length <= 3);
  assert.equal((await recall({ entity: "profile", query: "may" })).found, false);
});

test("nothing found says so and lists the page names", async () => {
  const { recall } = await seeded();
  const r = await recall({ query: "submarine" });
  assert.equal(r.found, false);
  assert.match(r.message, /Nothing in memory matches/);
  assert.deepEqual([...r.pages].sort(), ["Anouk", "Family", "Home", "Utrecht"]);
});

test("recall returns at most the exact page plus 3 others", async () => {
  const { h, recall } = await host();
  for (const n of ["A1", "A2", "A3", "A4", "A5"]) await h.request("POST", "pages", { name: n, body: "boat trip" });
  await h.request("POST", "pages", { name: "Boat", body: "the boat" });
  const r = await recall({ entity: "A1", query: "boat" });
  assert.equal(r.pages.length, 4);
  assert.equal(r.pages[0].name, "A1");
  assert.equal(r.pages[1].name, "Boat");
});

test("the module's only tools are brain_remember and brain_recall, in both channels", async () => {
  const { h } = await host();
  assert.deepEqual(h.tools, ["brain_remember", "brain_recall"]);
  assert.deepEqual(h.toolsIn("voice"), ["brain_remember", "brain_recall"]);
  assert.deepEqual(h.toolsIn("chat"), ["brain_remember", "brain_recall"]);
});
