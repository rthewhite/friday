import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuietEvent } from "@friday/sdk";
import { cursorOf } from "../src/conversations/store.js";
import { setup } from "./conversation-fixtures.js";
import { waitFor } from "./helpers.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const tick = () => new Promise((r) => setImmediate(r));

const at = "2026-10-01T10:00:00.000Z";

test("append keeps order by seq, moves last activity, counts entries and keeps the first user line as preview", () => {
  const { store, clock } = setup();
  const id = store.create({ channel: "voice", device: "kitchen" });
  clock.advance(1000);
  store.append(id, 1, { kind: "user", at, input: "speech", text: "x".repeat(200) });
  store.append(id, 3, { kind: "assistant", at, text: "done", interrupted: true });
  clock.advance(1000);
  store.append(id, 2, { kind: "tool", at, name: "media_play", args: { q: "up" }, result: { ok: true } });
  store.append(id, 4, { kind: "user", at, input: "text", text: "second" });
  const c = store.get(id)!;
  assert.equal(c.channel, "voice");
  assert.equal(c.device, "kitchen");
  assert.equal(c.startedAt, at);
  assert.equal(c.lastActivityAt, "2026-10-01T10:00:02.000Z");
  assert.equal(c.entryCount, 4);
  assert.equal(c.preview, "x".repeat(120));
  assert.equal(c.state, "active");
  assert.deepEqual(c.entries.map((e) => e.kind), ["user", "tool", "assistant", "user"]);
  assert.deepEqual(c.entries[1], { seq: 2, at, kind: "tool", name: "media_play", args: { q: "up" }, result: { ok: true }, truncated: false });
  assert.deepEqual(c.entries[2], { seq: 3, at, kind: "assistant", text: "done", interrupted: true });
  assert.deepEqual(c.entries[3], { seq: 4, at, kind: "user", input: "text", text: "second" });
  assert.equal(store.nextSeq(id), 5);
  assert.equal(store.nextSeq("nope"), undefined);
  assert.equal(store.get("nope"), undefined);
});

test("tool arguments and results over 4000 characters of JSON are cut and marked truncated; unsettled tools have no result", () => {
  const { store } = setup();
  const id = store.create({ channel: "voice" });
  store.append(id, 1, { kind: "tool", at, name: "big", args: { q: 1 }, result: { blob: "y".repeat(20000) } });
  store.append(id, 2, { kind: "tool", at, name: "pending", args: undefined });
  const [big, pending] = store.get(id)!.entries;
  assert.equal(big.kind === "tool" && big.truncated, true);
  assert.deepEqual(big.kind === "tool" && big.args, { q: 1 });
  assert.equal(typeof (big.kind === "tool" && big.result), "string");
  assert.equal((big as { result: string }).result.length, 4000);
  assert.deepEqual(pending, { seq: 2, at, kind: "tool", name: "pending", args: null, truncated: false });
});

test("recent-first paging over 120 conversations with an opaque before cursor", () => {
  const { store, clock } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) {
    // pairs share a timestamp so the id tie-break is exercised
    if (i % 2 === 0) clock.advance(1000);
    ids.push(store.create({ channel: "chat" }));
  }
  const first = store.list();
  assert.equal(first.length, 50);
  const second = store.list({ before: cursorOf(first.at(-1)!) });
  assert.equal(second.length, 50);
  const third = store.list({ before: cursorOf(second.at(-1)!), limit: 50 });
  assert.equal(third.length, 20);
  const all = [...first, ...second, ...third];
  assert.equal(new Set(all.map((c) => c.id)).size, 120);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].lastActivityAt >= all[i].lastActivityAt);
  assert.deepEqual(new Set(all.map((c) => c.id)), new Set(ids));
  assert.equal(store.list({ limit: 5 }).length, 5);
  assert.throws(() => store.list({ before: "garbage" }), /invalid cursor/);
});

test("quietSince lists quiet conversations oldest first, and a resumed thread moves its quiet_at forward", () => {
  const { store, clock } = setup();
  const a = store.create({ channel: "chat" });
  const b = store.create({ channel: "chat" });
  const active = store.create({ channel: "chat" });
  store.append(a, 1, { kind: "user", at, input: "text", text: "a" });
  store.append(b, 1, { kind: "user", at, input: "text", text: "b" });
  clock.advance(1000);
  assert.equal(store.markQuiet(b), true);
  clock.advance(1000);
  assert.equal(store.markQuiet(a), true);
  assert.equal(store.markQuiet(a), false, "already quiet");
  const watermark = "2026-10-01T10:00:00Z";
  assert.deepEqual(store.list({ quietSince: watermark }).map((c) => c.id), [b, a]);
  assert.ok(!store.list({ quietSince: watermark }).some((c) => c.id === active));
  const firstQuiet = store.get(b)!.quietAt!;
  assert.deepEqual(store.list({ quietSince: firstQuiet }).map((c) => c.id), [a]);

  clock.advance(1000);
  store.append(b, 2, { kind: "user", at, input: "text", text: "again" });
  assert.equal(store.get(b)!.state, "active");
  assert.equal(store.get(b)!.quietAt, null);
  assert.equal(store.get(b)!.preview, "b");
  assert.deepEqual(store.list({ quietSince: watermark }).map((c) => c.id), [a], "an active thread is not listed");
  clock.advance(1000);
  store.markQuiet(b);
  assert.ok(store.get(b)!.quietAt! > firstQuiet);
  assert.deepEqual(store.list({ quietSince: store.get(a)!.quietAt! }).map((c) => c.id), [b], "the resumed thread reappears after the watermark");
  assert.throws(() => store.list({ quietSince: "yesterday" }), /invalid quietSince/);
});

test("an explicit end records the end time and reason; resuming clears them", () => {
  const { store, clock } = setup();
  const id = store.create({ channel: "voice" });
  store.append(id, 1, { kind: "user", at, input: "speech", text: "hi" });
  clock.advance(5000);
  store.markQuiet(id, { reason: "ended: no follow-up" });
  let c = store.get(id)!;
  assert.equal(c.state, "quiet");
  assert.equal(c.endReason, "ended: no follow-up");
  assert.equal(c.endedAt, "2026-10-01T10:00:05.000Z");
  store.append(id, 2, { kind: "user", at, input: "text", text: "more" });
  c = store.get(id)!;
  assert.equal(c.endReason, null);
  assert.equal(c.endedAt, null);
});

test("delete cascades to entries, refuses live conversations and reports unknown ids", () => {
  const { db, store } = setup();
  const id = store.create({ channel: "voice" });
  store.append(id, 1, { kind: "user", at, input: "speech", text: "hi" });
  store.attach(id);
  assert.equal(store.delete(id), "live");
  store.detach(id);
  assert.equal(store.delete(id), "deleted");
  assert.equal(store.get(id), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversation_entries").get() as { n: number }).n, 0);
  assert.equal(store.delete(id), "missing");
});

test("prune deletes in batches by last activity and skips live conversations", () => {
  const { store, clock } = setup();
  const old = Array.from({ length: 7 }, () => store.create({ channel: "voice" }));
  store.attach(old[0]);
  clock.advance(100 * DAY);
  const recent = store.create({ channel: "voice" });
  const cutoff = new Date(clock.now().getTime() - 90 * DAY);
  assert.equal(store.prune(cutoff, 4), 4);
  assert.equal(store.prune(cutoff, 4), 2);
  assert.equal(store.prune(cutoff, 4), 0);
  assert.ok(store.get(old[0]), "live one kept");
  assert.ok(store.get(recent));
});

test("the sweep quiets idle conversations after the quiet period, but not live ones", async () => {
  const { store, clock } = setup({ quietMinutes: 30 });
  const idle = store.create({ channel: "chat" });
  const live = store.create({ channel: "chat" });
  store.append(idle, 1, { kind: "user", at, input: "text", text: "hi" });
  store.attach(live);
  const seen: QuietEvent[] = [];
  store.onQuiet((e) => void seen.push(e));
  clock.advance(29 * MIN);
  assert.equal(store.sweep(), 0);
  clock.advance(2 * MIN);
  assert.equal(store.sweep(), 1);
  assert.equal(store.get(idle)!.state, "quiet");
  assert.equal(store.get(idle)!.endReason, null, "idle quiet has no end reason");
  assert.equal(store.get(live)!.state, "active");
  await tick();
  assert.deepEqual(seen, [{ id: idle, lastActivityAt: at, quietAt: "2026-10-01T10:31:00.000Z" }]);
  store.detach(live);
  assert.equal(store.sweep(), 1, "no longer live");
});

test("start sweeps right away and then on the interval; stop ends it", async () => {
  const { store, clock } = setup({ quietMinutes: 1, sweepMs: 10 });
  const a = store.create({ channel: "chat" });
  clock.advance(2 * MIN);
  store.start();
  assert.equal(store.get(a)!.state, "quiet");
  const b = store.create({ channel: "chat" });
  clock.advance(2 * MIN);
  await waitFor(() => store.get(b)!.state === "quiet");
  store.stop();
  const c = store.create({ channel: "chat" });
  clock.advance(2 * MIN);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.get(c)!.state, "active");
});

test("subscribers run after the write, a throwing one does not block others, and resume-then-quiet notifies twice", async () => {
  const { store, clock, errors } = setup();
  const seen: QuietEvent[] = [];
  const states: string[] = [];
  store.onQuiet(() => { throw new Error("boom"); }, "bad");
  store.onQuiet(async () => { throw new Error("async boom"); }, "worse");
  store.onQuiet((e) => { seen.push(e); states.push(store.get(e.id)!.state); }, "good");
  const id = store.create({ channel: "chat" });
  store.append(id, 1, { kind: "user", at, input: "text", text: "hi" });
  store.markQuiet(id);
  assert.equal(seen.length, 0, "not synchronous");
  await tick();
  clock.advance(60 * MIN);
  store.append(id, 2, { kind: "user", at, input: "text", text: "again" });
  store.markQuiet(id, { reason: "done" });
  await tick();
  await tick();
  assert.equal(seen.length, 2);
  assert.deepEqual(states, ["quiet", "quiet"]);
  assert.ok(seen[1].lastActivityAt > seen[0].lastActivityAt);
  assert.ok(seen[1].quietAt > seen[0].quietAt);
  assert.ok(errors.some((l) => l.includes("of bad") && l.includes("boom") && l.includes(id)));
  assert.ok(errors.some((l) => l.includes("of worse") && l.includes("async boom")));
});

test("forOwner gives read access and removeOwner drops that owner's subscriptions", async () => {
  const { store } = setup();
  const m = store.forOwner("brain");
  let a = 0, b = 0;
  m.onQuiet(() => void a++);
  const off = store.onQuiet(() => void b++, "other");
  const id = store.create({ channel: "voice" });
  store.append(id, 1, { kind: "user", at, input: "speech", text: "hi" });
  store.markQuiet(id);
  await tick();
  assert.deepEqual([a, b], [1, 1]);
  assert.deepEqual((await m.list({ quietSince: "2026-01-01T00:00:00Z" })).map((c) => c.id), [id]);
  assert.equal((await m.get(id))!.entries.length, 1);
  store.removeOwner("brain");
  off();
  store.append(id, 2, { kind: "user", at, input: "speech", text: "again" });
  store.markQuiet(id);
  await tick();
  assert.deepEqual([a, b], [1, 1]);
});

test("settings default to 90 retention days and 30 quiet minutes", async () => {
  delete process.env.FRIDAY_CONVERSATION_RETENTION_DAYS;
  delete process.env.FRIDAY_CONVERSATION_QUIET_MINUTES;
  const { settings } = await import("../src/config.js");
  assert.equal(settings.conversationRetentionDays, 90);
  assert.equal(settings.conversationQuietMinutes, 30);
});
