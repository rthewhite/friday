import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, type LlmRequest } from "@friday/sdk";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { extractConversation } from "../src/nightly/extract.js";
import { renderBrain } from "../src/nightly/render.js";
import { BrainStore } from "../src/store.js";
import { loadFixtures, seedFixture, type Fixture } from "./nightly/load.js";

const fixtures = new Map(loadFixtures().map((f) => [f.name, f]));
const fixture = (name: string): Fixture => fixtures.get(name)!;

type Answer = (req: LlmRequest) => unknown;

/** A test host whose fake model answers extraction with `extract` and consolidation with an empty plan. */
async function host(extract: Answer = () => ({ notes: [] }), env: Record<string, string> = {}) {
  let now = new Date("2026-09-30T01:00:00Z");
  const extractions: LlmRequest[] = [];
  const h = await createTestHost(createBrainModule({ now: () => now }), {
    env,
    llm: (req) => {
      const isExtract = !!(req.schema as { properties?: Record<string, unknown> })?.properties?.notes;
      if (!isExtract) return JSON.stringify({ actions: [], note: "nothing to tidy" });
      extractions.push(req);
      const a = extract(req);
      if (a instanceof Error) throw a;
      return typeof a === "string" ? a : JSON.stringify(a);
    },
  });
  const body = (name: string) => (h.db.prepare("SELECT p.body FROM brain__names n JOIN brain__pages p ON p.id = n.page_id WHERE n.key = ?").get(name.toLowerCase()) as { body: string } | undefined)?.body;
  const run = async () => {
    const r = await h.runJob("nightly");
    const row = h.db.prepare("SELECT * FROM brain__runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    return { ...r, row: { ...row } };
  };
  return { h, extractions, body, run, setNow: (iso: string) => void (now = new Date(iso)) };
}

const quietConversation = (h: Awaited<ReturnType<typeof host>>["h"], id: string, text: string, quietAt: string, extra: object = {}) =>
  h.conversations.seed({ id, channel: "chat", startedAt: quietAt, lastActivityAt: quietAt, quietAt, entries: [{ kind: "user", input: "text", text }], ...extra });

// ---- 3.1 rendering ----

test("the model never sees tool results; tool calls show name and arguments, brain_remember as already remembered", async () => {
  const t = await host();
  await seedFixture(t.h, fixture("injected-tool-result"));
  await t.run();
  const req = t.extractions[0]!;
  const input = `${req.system}\n${req.prompt}`;
  for (const secret of ["hunter2", "1234", "IMPORTANT SYSTEM NOTE", "Open 9-17"]) assert.ok(!input.includes(secret), secret);
  assert.match(req.prompt!, /tool fetch_page\(\{"url":"https:\/\/library.example\/hours"\}\)/);

  const r = await host();
  await seedFixture(r.h, fixture("already-remembered"));
  await r.run();
  assert.match(r.extractions[0]!.prompt!, /\(already remembered: Anouk: Birthday is 3 November\.\)/);
  assert.ok(!r.extractions[0]!.prompt!.includes('"stored":true'));
});

test("the transcript marks earlier and new entries, speech, typing, interruptions and the device", async () => {
  const t = await host();
  await seedFixture(t.h, fixture("resumed"));
  await t.run();
  const p = t.extractions[0]!.prompt!;
  const [before, after] = p.split("\n[new]\n");
  assert.match(before!, /\[earlier\] \(context only; already processed\)\nuser \(typed\): The boiler was serviced in September, the engineer was Kees\.\nfriday: Good to know\./);
  assert.ok(!after!.includes("boiler"));
  assert.match(after!, /^user \(typed\): Also, the recycling is collected every other Tuesday/);
  assert.match(p, /^Conversation on Tuesday 2026-09-29, channel chat\./);

  const v = await host();
  await seedFixture(v.h, fixture("correction"));
  v.h.conversations.seed({ channel: "voice", device: "kitchen", lastActivityAt: "2026-09-29T08:00:00Z", quietAt: "2026-09-29T08:30:00Z", entries: [{ kind: "user", input: "speech", text: "put the lights on in here please" }, { kind: "assistant", text: "Turning the", interrupted: true }] });
  await v.run();
  const kitchen = v.extractions.map((r) => r.prompt!).find((x) => x.includes("kitchen"))!;
  assert.match(kitchen, /device "kitchen" \(a device, not a person\)/);
  assert.match(kitchen, /user \(spoken, transcribed\): put the lights on/);
  assert.match(kitchen, /friday \(interrupted\): Turning the/);
});

test("the brain rendering lists dangling links and forgotten names, and an oversized brain keeps the most relevant pages in full", async () => {
  const t = await host();
  await t.h.request("POST", "pages", { name: "Old job" }).then(async ({ body }) => {
    const id = (body as { id: string }).id;
    await t.h.request("DELETE", `pages/${id}`);
    await t.h.request("POST", `pages/${id}/purge`, { confirm: "Old job" });
  });
  await t.h.request("POST", "pages", { name: "Home", type: "place", body: "Wifi password is on the router label. Near [[Utrecht]]." });
  for (let i = 1; i <= 5; i++) await t.h.request("POST", "pages", { name: `Big ${i}`, body: `Filler ${"lorem ipsum ".repeat(1500)}` });
  const store = new BrainStore(t.h.db);
  const text = renderBrain(store, "what was the wifi router password again?");
  assert.ok(text.length <= 60000, `${text.length}`);
  assert.match(text, /### Profile \(the user and the household\)\n\(empty\)/);
  assert.match(text, /### Home \(place\)\nWifi password is on the router label/);
  assert.match(text, /### Other pages \(index only\)\n- Big \d \(other\)/);
  assert.match(text, /## Links to pages that don't exist yet\n- Utrecht/);
  assert.match(text, /## Deliberately forgotten: never record these\n- Old job/);
  // Small brains are sent in full.
  const small = renderBrain(store, "", 1_000_000);
  assert.equal((small.match(/^### Big/gm) ?? []).length, 5);
});

// ---- 3.2 notes ----

test("a fact said in passing becomes a sourced extraction note dated with the conversation's day", async () => {
  const t = await host(() => fixture("birthday-in-passing").fake);
  const id = await seedFixture(t.h, fixture("birthday-in-passing"));
  const r = await t.run();
  assert.equal(r.outcome, "ok");
  assert.match(r.summary!, /^1 conversation \(0 trivial\), 1 note;/);
  assert.equal(t.body("Anouk"), "My sister.\n\n## Notes\n- 2026-09-29: Birthday is on 3 November.");
  const rev = t.h.db.prepare("SELECT author, sources_json FROM brain__revisions ORDER BY id DESC LIMIT 1").get() as { author: string; sources_json: string };
  assert.deepEqual({ ...rev }, { author: "extraction", sources_json: JSON.stringify([id]) });
  assert.deepEqual([t.extractions[0]!.model, t.extractions[0]!.temperature, t.extractions[0]!.maxOutputTokens], ["standard", 0.2, 4096]);
});

test("the date shown to the model is the date the notes get, even if the zone changes during the model call", async () => {
  const t = await host();
  const c = { id: "c1", channel: "chat", startedAt: "2026-09-28T23:30:00Z", lastActivityAt: "2026-09-28T23:30:00Z", entries: [{ seq: 1, at: "2026-09-28T23:30:00Z", kind: "user", input: "text", text: "Bram got a cat today" }] };
  // 23:30 UTC is the 29th in Amsterdam and still the 28th in New York.
  const zones = ["Europe/Amsterdam", "America/New_York"];
  let prompt = "";
  const deps = {
    store: new BrainStore(t.h.db),
    llm: { generate: async (req: LlmRequest) => { prompt = req.prompt; return { text: "", json: { notes: [{ entity: "Bram", fact: "Has a cat" }] }, model: "fake", usage: { inputTokens: 0, outputTokens: 0 } }; } },
    log: { log() {}, warn() {}, error() {} },
    zone: () => zones.shift() ?? "UTC",
  };

  await extractConversation(deps as never, c as never, 0, new AbortController().signal);

  assert.match(prompt, /Conversation on Tuesday 2026-09-29/);
  assert.equal(t.body("Bram"), "## Notes\n- 2026-09-29: Has a cat");
  assert.deepEqual(zones, ["America/New_York"], "the zone is read once per conversation");
});

test("a note for a forgotten name is refused and counted; existing text is untouched", async () => {
  const t = await host(() => ({ notes: [{ entity: "Old job", fact: "Boss was Kees", reason: "x" }, { entity: "Anouk", fact: "Likes tea", reason: "x" }] }));
  const job = (await t.h.request("POST", "pages", { name: "Old job" })).body as { id: string };
  await t.h.request("DELETE", `pages/${job.id}`);
  await t.h.request("POST", `pages/${job.id}/purge`, { confirm: "Old job" });
  await t.h.request("POST", "pages", { name: "Anouk", body: "Intro line.\n\n## Notes\n- 2026-01-01: Older note" });
  quietConversation(t.h, "c1", "we talked about Anouk and my old job today", "2026-09-29T10:00:00Z");
  const r = await t.run();
  assert.match(r.summary!, /1 note \(1 refused\)/);
  assert.equal(r.row.refused, 1);
  assert.equal(t.body("Old job"), undefined);
  assert.equal(t.body("Anouk"), "Intro line.\n\n## Notes\n- 2026-01-01: Older note\n- 2026-09-29: Likes tea");
});

test("a fact remembered during the conversation is not added again by a run after midnight", async () => {
  const t = await host(() => fixture("already-remembered").fake);
  await seedFixture(t.h, fixture("already-remembered"));
  const r = await t.run();
  assert.equal(r.row.notes, 0);
  assert.equal((t.body("Anouk")!.match(/3 November/g) ?? []).length, 1);
});

test("a conversation extracted twice (a crash before its progress was saved) adds its notes once", async () => {
  const t = await host(() => ({ notes: [{ entity: "Home", fact: "The recycling goes out every other Tuesday.", reason: "x" }, { entity: "Home", fact: "The boiler is in the attic.", reason: "x" }] }));
  quietConversation(t.h, "c1", "the recycling goes out every other Tuesday and the boiler is in the attic", "2026-09-29T19:00:00Z");
  await t.run();
  const once = t.body("Home");
  // The next night the progress keys are gone, as after a crash mid-conversation.
  await t.h.storage.delete("extract:seen:c1");
  await t.h.storage.delete("extract:watermark");
  t.setNow("2026-10-01T01:00:00Z");
  const again = await t.run();
  assert.equal(t.extractions.length, 2, "the conversation was extracted again");
  assert.equal(again.row.notes, 0);
  assert.equal(t.body("Home"), once);
});

// ---- 3.3 watermark, progress, retries ----

test("a backlog of 70 conversations is worked through 30, 30 and 10 per run", async () => {
  const t = await host();
  for (let i = 0; i < 70; i++) quietConversation(t.h, `c${String(i).padStart(2, "0")}`, `conversation number ${i} with enough words`, new Date(Date.parse("2026-09-01T00:00:00Z") + i * 60_000).toISOString());
  const counts: number[] = [];
  for (let run = 0; run < 4; run++) {
    const before = t.extractions.length;
    await t.run();
    counts.push(t.extractions.length - before);
  }
  assert.deepEqual(counts, [30, 30, 10, 0]);
  assert.ok(t.extractions[0]!.prompt!.includes("conversation number 0 "), "oldest first");
  assert.deepEqual((await t.h.storage.get("extract:watermark")), { quietAt: new Date(Date.parse("2026-09-01T00:00:00Z") + 69 * 60_000).toISOString(), ids: ["c69"] });
});

test("BRAIN_NIGHTLY_MAX_CONVERSATIONS sets the per-run limit", async () => {
  const t = await host(undefined, { BRAIN_NIGHTLY_MAX_CONVERSATIONS: "2" });
  for (let i = 0; i < 3; i++) quietConversation(t.h, `c${i}`, `conversation number ${i} with words`, `2026-09-0${i + 1}T00:00:00.000Z`);
  await t.run();
  assert.equal(t.extractions.length, 2);
});

test("a resumed conversation extracts only its new entries, with the old ones as context", async () => {
  const t = await host();
  quietConversation(t.h, "c1", "the first thing I said about the garden shed", "2026-09-28T10:00:00Z");
  await t.run();
  t.h.conversations.seed({
    id: "c1", channel: "chat", startedAt: "2026-09-28T10:00:00Z", lastActivityAt: "2026-09-29T10:00:00Z", quietAt: "2026-09-29T10:30:00Z",
    entries: [{ kind: "user", input: "text", text: "the first thing I said about the garden shed" }, { kind: "user", input: "text", text: "and now something new about the shed roof" }],
  });
  await t.run();
  const p = t.extractions[1]!.prompt!;
  assert.match(p, /\[earlier\][^]*the first thing I said[^]*\[new\]\nuser \(typed\): and now something new/);
});

test("a trivial conversation is skipped without a model call", async () => {
  const t = await host();
  quietConversation(t.h, "c1", "pause", "2026-09-29T10:00:00Z");
  const r = await t.run();
  assert.equal(t.extractions.length, 0);
  assert.match(r.summary!, /^1 conversation \(1 trivial\), 0 notes/);
  assert.deepEqual(await t.h.storage.get("extract:seen:c1"), { seq: 1 });
});

test("an invalid answer is retried on the next runs and given up after 3 attempts", async () => {
  const t = await host((req) => (req.prompt!.includes("broken conversation") ? "not json" : { notes: [] }));
  quietConversation(t.h, "bad", "this is the broken conversation text", "2026-09-29T10:00:00Z");
  quietConversation(t.h, "good", "this is a perfectly normal conversation", "2026-09-29T11:00:00Z");
  const attempts = () => t.extractions.filter((r) => r.prompt!.includes("broken conversation")).length;
  const r1 = await t.run();
  assert.equal(r1.outcome, "ok");
  assert.equal(attempts(), 1);
  assert.equal(t.extractions.filter((r) => r.prompt!.includes("perfectly normal")).length, 1, "the other conversation is still handled");
  assert.deepEqual((await t.h.storage.get<{ attempts: number }>("extract:retry:bad"))?.attempts, 1);
  await t.run();
  assert.equal(attempts(), 2);
  const r3 = await t.run();
  assert.equal(attempts(), 3);
  assert.match(String(r3.row.error), /gave up on conversation bad \(invalid_output\)/);
  assert.equal(await t.h.storage.get("extract:retry:bad"), undefined);
  await t.run();
  assert.equal(attempts(), 3, "given up: not tried again");
});

test("an unavailable model stops extraction as partial, and the next run starts from the same conversation", async () => {
  let down = true;
  const t = await host((req) => (down ? new LlmError("unavailable", "daily quota exhausted") : { notes: [] }));
  quietConversation(t.h, "c1", "first conversation with some words", "2026-09-29T10:00:00Z");
  quietConversation(t.h, "c2", "second conversation with some words", "2026-09-29T11:00:00Z");
  const r1 = await t.run();
  assert.equal(r1.row.outcome, "partial");
  assert.match(r1.summary!, /\[partial: model unavailable: daily quota exhausted\]/);
  assert.equal(t.extractions.length, 1);
  assert.equal(await t.h.storage.get("extract:watermark"), undefined);
  down = false;
  await t.run();
  assert.deepEqual(t.extractions.slice(1).map((r) => r.prompt!.match(/(first|second) conversation/)![1]), ["first", "second"]);
});

test("an aborted run stops at the next conversation, is partial, and skips consolidation", async () => {
  const { RunStore } = await import("../src/nightly/runs.js");
  const { runNightly } = await import("../src/nightly/job.js");
  const { runExtract } = await import("../src/nightly/extract.js");
  const t = await host();
  quietConversation(t.h, "c1", "first conversation with some words", "2026-09-29T10:00:00Z");
  quietConversation(t.h, "c2", "second conversation with some words", "2026-09-29T11:00:00Z");
  const ac = new AbortController();
  const deps = {
    store: new BrainStore(t.h.db),
    conversations: t.h.conversations,
    // The first model call finishes, then the job is cancelled (timeout, reload or shutdown).
    llm: { generate: async () => { ac.abort(); return { text: "{\"notes\":[]}", json: { notes: [] }, model: "fake", usage: { inputTokens: 0, outputTokens: 0 } }; } },
    storage: t.h.storage,
    log: { log() {}, warn() {}, error() {} },
    maxConversations: () => 30,
    zone: () => "Europe/Amsterdam",
  };
  let consolidated = false;
  const { run, summary } = await runNightly(new RunStore(t.h.db), { extract: (s) => runExtract(deps as never, s), consolidate: async () => { consolidated = true; return { ran: false, rewrites: 0, creates: 0, merges: [], dropped: [] }; } }, "schedule", ac.signal);
  assert.equal(run.outcome, "partial");
  assert.equal(run.error, "cancelled");
  assert.equal(run.conversations, 1);
  assert.equal(consolidated, false);
  assert.match(summary, /\[partial: cancelled\]/);
  // The watermark stops after the first conversation, so the next run starts with the second.
  assert.deepEqual(await t.h.storage.get("extract:watermark"), { quietAt: "2026-09-29T10:00:00Z", ids: ["c1"] });
});

test("a retried conversation that went quiet again never moves the watermark past unhandled ones", async () => {
  let mode: "bad-x" | "down-at-a" | "ok" = "bad-x";
  const t = await host((req) => {
    const p = req.prompt!;
    if (mode === "bad-x" && p.includes("conversation x")) return "not json";
    if (mode === "down-at-a" && p.includes("conversation a")) return new LlmError("unavailable", "quota");
    return { notes: [] };
  });
  quietConversation(t.h, "x", "this is conversation x talking", "2026-09-29T09:00:00.000Z");
  await t.run();
  assert.ok(await t.h.storage.get("extract:retry:x"));
  // X resumes and goes quiet later than two new conversations.
  t.h.conversations.seed({ id: "x", channel: "chat", startedAt: "2026-09-29T09:00:00.000Z", lastActivityAt: "2026-09-29T14:00:00.000Z", quietAt: "2026-09-29T15:00:00.000Z", entries: [{ kind: "user", input: "text", text: "this is conversation x talking" }, { kind: "user", input: "text", text: "and conversation x again later on" }] });
  quietConversation(t.h, "a", "this is conversation a talking", "2026-09-29T10:00:00.000Z");
  quietConversation(t.h, "b", "this is conversation b talking", "2026-09-29T11:00:00.000Z");
  mode = "down-at-a";
  const stopped = await t.run();
  assert.equal(stopped.row.outcome, "partial");
  assert.deepEqual(await t.h.storage.get("extract:watermark"), { quietAt: "2026-09-29T09:00:00.000Z", ids: ["x"] }, "not moved past A");
  mode = "ok";
  const before = t.extractions.length;
  await t.run();
  const next = t.extractions.slice(before).map((r) => /conversation (\w)/.exec(r.prompt!)![1]);
  assert.ok(next.includes("a") && next.includes("b"), `A and B are read: ${next}`);
});

test("conversations that went quiet in the same millisecond are all read, across runs", async () => {
  const t = await host(undefined, { BRAIN_NIGHTLY_MAX_CONVERSATIONS: "1" });
  const same = "2026-09-29T10:00:00.000Z";
  quietConversation(t.h, "a", "this is conversation a talking", same);
  quietConversation(t.h, "b", "this is conversation b talking", same);
  await t.run();
  await t.run();
  await t.run();
  const read = t.extractions.map((r) => /conversation (\w)/.exec(r.prompt!)![1]).sort();
  assert.deepEqual(read, ["a", "b"]);
  assert.deepEqual(await t.h.storage.get("extract:watermark"), { quietAt: same, ids: ["a", "b"] });
});

test("a deleted conversation is skipped and its progress forgotten", async () => {
  const t = await host();
  quietConversation(t.h, "c1", "a conversation that will be deleted later", "2026-09-29T10:00:00Z");
  await t.run();
  assert.ok(await t.h.storage.get("extract:seen:c1"));
  // Retention removed it (the in-memory store has no delete, so replace the map entry).
  (t.h.conversations as unknown as { items: Map<string, unknown> }).items.delete("c1");
  await t.run();
  assert.equal(await t.h.storage.get("extract:seen:c1"), undefined);
});
