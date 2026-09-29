import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { localDate } from "@friday/sdk";
import { createBrainModule } from "../src/index.js";

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

test("an invalid FRIDAY_TIMEZONE dates notes in Europe/Amsterdam and warns once", async () => {
  // 23:30 UTC on 28 September is the 29th in Amsterdam: a UTC fallback would write the 28th.
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.join(" "));
  const h = await createTestHost(createBrainModule({ now: () => new Date("2026-09-28T23:30:00Z") }), { env: { FRIDAY_TIMEZONE: "Mars/Olympus" }, log: { log: push, warn: push, error: push } });

  await h.call("brain_remember", { entity: "Bram", fact: "Has a cat" });
  await h.call("brain_remember", { entity: "Bram", fact: "Plays chess" });

  const row = h.db.prepare("SELECT body FROM brain__pages WHERE name = 'Bram'").get() as { body: string };
  assert.equal(row.body, "## Notes\n- 2026-09-29: Has a cat\n- 2026-09-29: Plays chess");
  assert.equal(lines.filter((l) => l.includes("Mars/Olympus")).length, 1);
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

test("the module's tools are brain_remember, brain_recall and brain_recall_conversations, in both channels", async () => {
  const { h } = await host();
  const all = ["brain_remember", "brain_recall", "brain_recall_conversations"];
  assert.deepEqual(h.tools, all);
  assert.deepEqual(h.toolsIn("voice"), all);
  assert.deepEqual(h.toolsIn("chat"), all);
});

// ---- 3.1 brain_recall_conversations ----

type Seed = Parameters<Awaited<ReturnType<typeof createTestHost>>["conversations"]["seed"]>[0];
const said = (kind: "user" | "assistant", text: string, at: string) =>
  kind === "user" ? { kind, input: "speech" as const, text, at } : { kind, text, interrupted: false, at };

async function conversations(...seeds: Seed[]) {
  const { h } = await host();
  const ids = seeds.map((s) => h.conversations.seed(s).id);
  const recallConversations = async (args: Record<string, unknown>, conversationId?: string) =>
    (await h.call("brain_recall_conversations", args, { channel: "voice", conversationId })).result as any;
  return { h, ids, recallConversations };
}

test("recall last week's film: the chat about it is found, with its start in local time", async () => {
  const { ids, recallConversations } = await conversations(
    {
      channel: "chat",
      startedAt: "2026-09-22T18:00:00.000Z",
      lastActivityAt: "2026-09-22T18:02:00.000Z",
      entries: [
        said("user", "Which film should we watch tonight?", "2026-09-22T18:00:00.000Z"),
        said("assistant", "How about Arrival? It's on Jellyfin.", "2026-09-22T18:01:00.000Z"),
        said("user", "Sounds good", "2026-09-22T18:02:00.000Z"),
      ],
    },
    { startedAt: "2026-09-18T18:00:00.000Z", entries: [said("user", "a film about sharks", "2026-09-18T18:00:00.000Z")] },
  );
  const r = await recallConversations({ query: "the film we talked about", since: "2026-09-21", until: "2026-09-27" });
  assert.equal(r.found, 1);
  const [c] = r.conversations;
  assert.deepEqual({ id: c.id, channel: c.channel, started: c.started, device: c.device }, { id: ids[0], channel: "chat", started: "2026-09-22 20:00", device: undefined });
  assert.deepEqual(c.snippets, [
    [
      { who: "user", text: "Which film should we watch tonight?" },
      { who: "friday", text: "How about Arrival? It's on Jellyfin." },
    ],
  ]);
});

test("the conversation the call is made in is left out", async () => {
  const { ids, recallConversations } = await conversations({ entries: [said("user", "what did we say about the boiler?", "2026-09-29T08:00:00.000Z")] });
  const r = await recallConversations({ query: "boiler" }, ids[0]);
  assert.deepEqual(r, { found: 0, message: "No earlier conversations matched." });
  assert.equal((await recallConversations({ query: "boiler" })).found, 1, "found from any other conversation");
});

test("yesterday without words: the conversations with entries on that local day, most recent first, with their opening turns", async () => {
  const { ids, recallConversations } = await conversations(
    // 00:30 on the 28th in Amsterdam
    { lastActivityAt: "2026-09-27T22:40:00.000Z", entries: [said("user", "good night", "2026-09-27T22:30:00.000Z"), said("assistant", "Sleep well", "2026-09-27T22:31:00.000Z")] },
    // 14:00 on the 28th, four turns
    {
      lastActivityAt: "2026-09-28T12:03:00.000Z",
      entries: ["a", "b", "c", "d"].map((t, i) => said(i % 2 ? "assistant" : "user", t, `2026-09-28T12:0${i}:00.000Z`)),
    },
    // 00:30 on the 29th: today, not yesterday
    { lastActivityAt: "2026-09-28T22:30:00.000Z", entries: [said("user", "late", "2026-09-28T22:30:00.000Z")] },
    // 23:30 on the 27th
    { lastActivityAt: "2026-09-27T21:30:00.000Z", entries: [said("user", "earlier", "2026-09-27T21:30:00.000Z")] },
  );
  const r = await recallConversations({ since: "2026-09-28", until: "2026-09-28" });
  assert.deepEqual(r.conversations.map((c: { id: string }) => c.id), [ids[1], ids[0]]);
  assert.deepEqual(r.conversations[0].snippets, [[{ who: "user", text: "a" }, { who: "friday", text: "b" }, { who: "user", text: "c" }]]);
});

test("played media is found through the tool call's arguments, and its result is never returned", async () => {
  const { ids, recallConversations } = await conversations({
    device: "living-room",
    startedAt: "2026-09-26T19:00:00.000Z",
    entries: [
      said("user", "continue the war series", "2026-09-26T19:00:00.000Z"),
      { kind: "tool", name: "play_on_apple_tv", args: { title: "Band of Brothers", episode: 4 }, result: { playing: true, token: "secret" }, truncated: false, at: "2026-09-26T19:00:05.000Z" },
      said("assistant", "Playing episode 4.", "2026-09-26T19:00:06.000Z"),
    ],
  });
  const r = await recallConversations({ query: "Band of Brothers" });
  assert.equal(r.conversations[0].id, ids[0]);
  assert.equal(r.conversations[0].device, "living-room");
  assert.deepEqual(r.conversations[0].snippets[0][1], { who: "tool", tool: "play_on_apple_tv", args: { title: "Band of Brothers", episode: 4 } });
  assert.doesNotMatch(JSON.stringify(r), /secret|playing/);
});

test("a result over 8000 characters drops the lowest-ranked conversations until it fits", async () => {
  const long = (n: number) => `boiler ${"x".repeat(400)} ${n}`;
  const seeds: Seed[] = Array.from({ length: 5 }, (_, i) => ({
    lastActivityAt: `2026-09-2${i}T10:00:00.000Z`,
    entries: Array.from({ length: 9 }, (_, j) => said(j % 2 ? "assistant" : "user", long(j), `2026-09-2${i}T10:0${j}:00.000Z`)),
  }));
  const { ids, recallConversations } = await conversations(...seeds);
  const r = await recallConversations({ query: "boiler" });
  assert.ok(JSON.stringify(r).length <= 8000, `${JSON.stringify(r).length} characters`);
  assert.ok(r.found >= 1 && r.found < 5, `kept ${r.found}`);
  assert.equal(r.found, r.conversations.length);
  // Most recent (highest ranked) first, so the kept ones are the newest.
  assert.deepEqual(r.conversations.map((c: { id: string }) => c.id), [...ids].reverse().slice(0, r.found));
});

test("an invalid date or since after until is an error the model can act on", async () => {
  const { recallConversations } = await conversations();
  assert.deepEqual(await recallConversations({ since: "last week" }), { error: 'since must be a date as YYYY-MM-DD, got "last week"' });
  assert.match((await recallConversations({ until: "2026-02-30" })).error, /until must be a date as YYYY-MM-DD/);
  assert.deepEqual(await recallConversations({ since: "2026-09-28", until: "2026-09-27" }), { error: "since (2026-09-28) is after until (2026-09-27)" });
});

test("without parameters: the most recent conversations, at most 5; nothing found states the dates", async () => {
  const seeds: Seed[] = Array.from({ length: 7 }, (_, i) => ({ lastActivityAt: `2026-09-2${i}T10:00:00.000Z`, entries: [said("user", `talk ${i}`, `2026-09-2${i}T10:00:00.000Z`)] }));
  const { ids, recallConversations } = await conversations(...seeds);
  const r = await recallConversations({});
  assert.deepEqual(r.conversations.map((c: { id: string }) => c.id), [...ids].reverse().slice(0, 5));
  assert.deepEqual(await recallConversations({ query: "boiler", since: "2026-09-01", until: "2026-09-02" }), { found: 0, message: "No earlier conversations matched between 2026-09-01 and 2026-09-02." });
});

test("a query with no searchable words is an error, not a list of the latest conversations", async () => {
  const { recallConversations } = await conversations({ entries: [said("user", "the TV is broken", "2026-09-28T10:00:00.000Z")] });
  assert.match((await recallConversations({ query: "TV" })).error, /^query "TV" has no searchable words: .*"television" rather than "TV"/);
  assert.match((await recallConversations({ query: "what did we", since: "2026-09-28" })).error, /no searchable words/);
  assert.equal((await recallConversations({ query: "  ", since: "2026-09-28" })).found, 1, "a blank query is no query");
});

test("a best match over 8000 characters on its own is kept, with its later snippets dropped", async () => {
  // Control characters take 6 characters each in JSON, so three full snippets of these can't fit.
  const noisy = `boiler ${"\u0001".repeat(400)}`;
  const { ids, recallConversations } = await conversations(
    { lastActivityAt: "2026-09-28T10:00:00.000Z", entries: Array.from({ length: 9 }, (_, j) => said(j % 2 ? "assistant" : "user", noisy, `2026-09-28T10:0${j}:00.000Z`)) },
    { lastActivityAt: "2026-09-20T10:00:00.000Z", entries: [said("user", "boiler", "2026-09-20T10:00:00.000Z")] },
  );
  const r = await recallConversations({ query: "boiler" });
  assert.ok(JSON.stringify(r).length <= 8000, `${JSON.stringify(r).length} characters`);
  assert.equal(r.found, 1);
  assert.equal(r.conversations[0].id, ids[0]);
  assert.ok(r.conversations[0].snippets.length >= 1 && r.conversations[0].snippets.length < 3);
});

test("the no-match message names an open end even when the model passes an empty date", async () => {
  const { recallConversations } = await conversations();
  assert.deepEqual(await recallConversations({ query: "boiler", since: "", until: "2026-09-02" }), { found: 0, message: "No earlier conversations matched between the start and 2026-09-02." });
});

test("an until whose next day is past year 9999 is a date error, not a crash", async () => {
  const { recallConversations } = await conversations();
  assert.deepEqual(await recallConversations({ until: "9999-12-31" }), { error: 'until must be a date as YYYY-MM-DD, got "9999-12-31"' });
});

test("the channel parameter narrows to voice or chat", async () => {
  const { ids, recallConversations } = await conversations(
    { channel: "voice", entries: [said("user", "boiler", "2026-09-28T10:00:00.000Z")] },
    { channel: "chat", entries: [said("user", "boiler", "2026-09-28T10:00:00.000Z")] },
  );
  assert.deepEqual((await recallConversations({ query: "boiler", channel: "chat" })).conversations.map((c: { id: string }) => c.id), [ids[1]]);
});
