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
