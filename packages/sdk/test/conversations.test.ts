import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, type Conversation, type QuietEvent } from "../src/index.js";
import { createTestHost } from "../src/test.js";

test("test host: a seeded conversation marked quiet fires onQuiet, and get returns its entries", async () => {
  const seen: { event: QuietEvent; conversation?: Conversation }[] = [];
  const m = defineModule({
    manifest: { id: "brain", label: "Brain" },
    init(ctx) {
      ctx.conversations.onQuiet(async (event) => void seen.push({ event, conversation: await ctx.conversations.get(event.id) }));
    },
  });
  const h = await createTestHost(m);
  const c = h.conversations.seed({
    device: "kitchen",
    lastActivityAt: "2026-10-01T10:05:00.000Z",
    entries: [
      { kind: "user", input: "speech", text: "Play Dune" },
      { kind: "tool", name: "media_play", args: { q: "Dune" }, result: { ok: true }, truncated: false },
      { kind: "assistant", text: "Playing.", interrupted: false },
    ],
  });
  assert.equal(c.state, "active");
  assert.equal(c.preview, "Play Dune");
  assert.equal(c.entryCount, 3);
  const e = await h.conversations.markQuiet(c.id, "2026-10-01T10:35:00.000Z");
  assert.deepEqual(e, { id: c.id, lastActivityAt: "2026-10-01T10:05:00.000Z", quietAt: "2026-10-01T10:35:00.000Z" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conversation?.state, "quiet");
  assert.deepEqual(seen[0].conversation?.entries.map((x) => [x.seq, x.kind]), [[1, "user"], [2, "tool"], [3, "assistant"]]);
  assert.equal(seen[0].conversation?.device, "kitchen");
});

test("test host: list orders by activity, or by quiet time after a watermark; dispose drops subscriptions", async () => {
  let fired = 0;
  const h = await createTestHost(defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { ctx.conversations.onQuiet(() => void fired++); } }));
  const a = h.conversations.seed({ lastActivityAt: "2026-10-01T10:00:00.000Z" });
  const b = h.conversations.seed({ lastActivityAt: "2026-10-01T11:00:00.000Z" });
  await h.conversations.markQuiet(b.id, "2026-10-01T12:00:00.000Z");
  await h.conversations.markQuiet(a.id, "2026-10-01T13:00:00.000Z");
  assert.deepEqual((await h.conversations.list()).map((c) => c.id), [b.id, a.id]);
  assert.deepEqual((await h.conversations.list({ quietSince: "2026-10-01T11:30:00Z" })).map((c) => c.id), [b.id, a.id]);
  assert.deepEqual((await h.conversations.list({ quietSince: "2026-10-01T12:00:00Z" })).map((c) => c.id), [a.id]);
  assert.equal(await h.conversations.get("nope"), undefined);
  await assert.rejects(h.conversations.markQuiet("nope"), /no seeded conversation/);
  await h.dispose();
  await h.conversations.markQuiet(a.id);
  assert.equal(fired, 2);
});

// The ctx.conversations example from packages/sdk/README.md, verbatim.
const summaries: string[] = [];
const summarise = (c: Conversation) => void summaries.push(`${c.id}: ${c.entryCount} entries`);

const digest = defineModule({
  manifest: { id: "digest", label: "Digest" },
  init(ctx) {
    // Process every conversation that went quiet since the last run, exactly once.
    const catchUp = async () => {
      const since = (await ctx.storage.get<string>("watermark")) ?? new Date(0).toISOString();
      for (const c of await ctx.conversations.list({ quietSince: since, limit: 100 })) {
        const full = await ctx.conversations.get(c.id);
        if (full) summarise(full);
        await ctx.storage.set("watermark", c.quietAt);
      }
    };
    // Going quiet is a best-effort nudge; the watermark makes a missed one (a restart, a reload) harmless.
    let queue = Promise.resolve();
    const nudge = () => (queue = queue.then(catchUp).catch((e) => ctx.log.error("digest failed", e)));
    ctx.conversations.onQuiet(nudge);
    void nudge();
  },
});

test("README example: the watermark catches up on missed conversations and processes each once", async () => {
  const h = await createTestHost(digest);
  const missed = h.conversations.seed({ quietAt: "2026-10-01T03:00:00.000Z", entries: [{ kind: "user", input: "text", text: "hi" }] });
  const later = h.conversations.seed();
  await h.conversations.markQuiet(later.id, "2026-10-01T04:00:00.000Z");
  assert.deepEqual(summaries, [`${missed.id}: 1 entries`, `${later.id}: 0 entries`]);
  assert.equal(await h.storage.get("watermark"), "2026-10-01T04:00:00.000Z");
  await h.conversations.markQuiet(later.id, "2026-10-01T05:00:00.000Z");
  assert.equal(summaries.length, 3, "a conversation that goes quiet again is processed again");
});

const day = (d: string, t = "10:00") => `2026-09-${d}T${t}:00.000Z`;

test("search: the module sees only the matching conversation, with a snippet around the match", async () => {
  let search: ((q: string) => Promise<unknown>) | undefined;
  const h = await createTestHost(defineModule({ manifest: { id: "brain", label: "Brain" }, init(ctx) { search = async (query) => ctx.conversations.search({ query }); } }));
  h.conversations.seed({ id: "other", entries: [{ kind: "user", input: "speech", text: "what's the weather?" }] });
  h.conversations.seed({
    id: "boiler",
    startedAt: day("20"),
    entries: [
      { kind: "user", input: "speech", text: "when is the service?" },
      { kind: "assistant", text: "The boiler service is on Tuesday", interrupted: false },
      { kind: "user", input: "speech", text: "thanks" },
      { kind: "assistant", text: "You're welcome", interrupted: false },
    ],
  });
  const found = (await search!("boiler")) as { id: string; snippets: { seq: number; kind: string }[][] }[];
  assert.deepEqual(found.map((c) => c.id), ["boiler"]);
  assert.deepEqual(found[0].snippets.map((s) => s.map((e) => e.seq)), [[1, 2, 3]]);
  assert.equal("entries" in found[0], false);
});

test("search: best match first, parts of words and accents, active and quiet alike", async () => {
  const h = await createTestHost(defineModule({ manifest: { id: "m", label: "M" }, init() {} }));
  const a = h.conversations.seed({ lastActivityAt: day("21"), entries: [{ kind: "user", input: "speech", text: "the boiler is loud" }] });
  const b = h.conversations.seed({ lastActivityAt: day("20"), quietAt: day("20", "11:00"), entries: [{ kind: "user", input: "text", text: "book the boiler" }, { kind: "assistant", text: "Service booked.", interrupted: false }] });
  const c = h.conversations.seed({ lastActivityAt: day("22"), entries: [{ kind: "user", input: "speech", text: "de boilers in het café" }] });
  // b matches two distinct words; c and a one each, c more recently active.
  assert.deepEqual((await h.conversations.search({ query: "boiler service" })).map((x) => x.id), [b.id, c.id, a.id]);
  assert.deepEqual((await h.conversations.search({ query: "BOILER cafe" })).map((x) => x.id), [c.id, a.id, b.id]);
});

test("search: the time window, channel, device and excluded ids narrow the result", async () => {
  const h = await createTestHost(defineModule({ manifest: { id: "m", label: "M" }, init() {} }));
  const early = h.conversations.seed({ lastActivityAt: day("01"), entries: [{ kind: "user", input: "speech", text: "boiler", at: day("01") }] });
  const late = h.conversations.seed({
    channel: "chat",
    device: null,
    lastActivityAt: day("20"),
    entries: [
      { kind: "user", input: "text", text: "boiler question", at: day("10") },
      { kind: "user", input: "text", text: "boiler again", at: day("20") },
    ],
  });
  const kitchen = h.conversations.seed({ device: "kitchen", lastActivityAt: day("19"), entries: [{ kind: "user", input: "speech", text: "boiler", at: day("19") }] });
  const window = await h.conversations.search({ query: "boiler", since: day("15", "00:00") });
  assert.deepEqual(window.map((x) => x.id), [late.id, kitchen.id]);
  assert.deepEqual(window[0].snippets.flat().map((e) => e.at), [day("20")], "snippets come from entries in the window");
  assert.deepEqual((await h.conversations.search({ query: "boiler", channel: "chat" })).map((x) => x.id), [late.id]);
  assert.deepEqual((await h.conversations.search({ query: "boiler", device: "kitchen" })).map((x) => x.id), [kitchen.id]);
  assert.deepEqual((await h.conversations.search({ query: "boiler", exclude: [late.id, kitchen.id] })).map((x) => x.id), [early.id]);
  assert.deepEqual(await h.conversations.search({ query: "boiler", exclude: [late.id, kitchen.id, early.id] }), []);
});

test("search: without words, the conversations in the window with their first 3 entries, most recent first", async () => {
  const h = await createTestHost(defineModule({ manifest: { id: "m", label: "M" }, init() {} }));
  h.conversations.seed({ lastActivityAt: day("27"), entries: [{ kind: "user", input: "speech", text: "old", at: day("27") }] });
  const morning = h.conversations.seed({ lastActivityAt: day("28", "08:00"), entries: [{ kind: "user", input: "speech", text: "a", at: day("28", "08:00") }] });
  const evening = h.conversations.seed({
    lastActivityAt: day("28", "20:00"),
    entries: ["a", "b", "c", "d"].map((text, i) => ({ kind: "user" as const, input: "speech" as const, text, at: day("28", `20:0${i}`) })),
  });
  const found = await h.conversations.search({ since: day("28", "00:00"), until: day("29", "00:00") });
  assert.deepEqual(found.map((x) => x.id), [evening.id, morning.id]);
  assert.deepEqual(found[0].snippets.map((s) => s.map((e) => e.kind === "user" && e.text)), [["a", "b", "c"]]);
});

test("search: an invalid window is refused", async () => {
  const h = await createTestHost(defineModule({ manifest: { id: "m", label: "M" }, init() {} }));
  await assert.rejects(h.conversations.search({ since: day("20"), until: day("19") }), /since is after until/);
  await assert.rejects(h.conversations.search({ channel: "email" as never }), /invalid channel/);
});
