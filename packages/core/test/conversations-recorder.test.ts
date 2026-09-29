import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationEntry } from "@friday/sdk";
import type { ConversationRecorder, ToolHandle } from "../src/conversations/recorder.js";
import { setup } from "./conversation-fixtures.js";

/** One step of a replayed Gemini Live sequence, in the order GeminiSession sees them. */
type Step =
  | ["user", string]
  | ["typed", string]
  | ["bot", string]
  | ["call", string, string, unknown?]
  | ["result", string, unknown]
  | ["interrupted"]
  | ["turn"]
  | ["end", string];

function replay(r: ConversationRecorder, steps: Step[]): void {
  const calls = new Map<string, ToolHandle>();
  for (const s of steps) {
    switch (s[0]) {
      case "user": r.user(s[1], "speech"); break;
      case "typed": r.user(s[1], "text"); break;
      case "bot": r.assistant(s[1]); break;
      case "call": calls.set(s[1], r.tool(s[2], s[3])); break;
      case "result": calls.get(s[1])!.result(s[2]); break;
      case "interrupted": r.interrupted(); break;
      case "turn": r.turnComplete(); break;
      case "end": r.end(s[1]); break;
    }
  }
}

/** Entries without seq and time, for compact comparisons. */
const shape = (entries: ConversationEntry[]) =>
  entries.map((e) => {
    const { seq, at, ...rest } = e;
    return rest;
  });

function record(steps: Step[]) {
  const s = setup();
  const r = s.store.recorder({ channel: "voice", device: "kitchen" });
  replay(r, steps);
  const c = r.conversationId ? s.store.get(r.conversationId) : undefined;
  return { ...s, r, c, entries: c ? shape(c.entries) : [] };
}

test("nothing said: no conversation is stored", () => {
  const { db, r } = record([["user", "  "], ["bot", ""], ["turn"], ["end", "client closed"]]);
  assert.equal(r.conversationId, undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n, 0);
});

test("the conversation is created on its first entry, held live while recording, and ends quiet with the reason", () => {
  const s = setup();
  const r = s.store.recorder({ channel: "voice", device: "kitchen" });
  r.user("Hi", "speech");
  assert.equal(r.conversationId, undefined, "fragments alone do not create it");
  s.clock.advance(3000);
  r.assistant("Hello.");
  s.clock.advance(2000);
  r.turnComplete();
  const id = r.conversationId!;
  assert.ok(id);
  assert.equal(s.store.get(id)!.startedAt, "2026-10-01T10:00:00.000Z", "started when the first fragment arrived");
  assert.equal(s.store.get(id)!.lastActivityAt, "2026-10-01T10:00:05.000Z");
  assert.equal(s.store.isLive(id), true);
  assert.equal(s.store.get(id)!.state, "active");
  r.end("ended: no follow-up");
  const c = s.store.get(id)!;
  assert.equal(c.state, "quiet");
  assert.equal(c.endReason, "ended: no follow-up");
  assert.equal(c.channel, "voice");
  assert.equal(c.device, "kitchen");
  assert.equal(s.store.isLive(id), false);
  r.user("ignored", "speech");
  r.end("again");
  assert.equal(s.store.get(id)!.entryCount, 2);
});

test("a failing store never throws and is logged with the conversation id", () => {
  const s = setup();
  const r = s.store.recorder({ channel: "voice" }, { error: (...a: unknown[]) => void s.errors.push(a.join(" ")) });
  r.user("Hi", "speech");
  r.assistant("Hello");
  r.turnComplete();
  const id = r.conversationId!;
  s.store.append = () => { throw new Error("disk full"); };
  s.store.markQuiet = () => { throw new Error("disk still full"); };
  assert.doesNotThrow(() => {
    replay(r, [["user", "More"], ["call", "a", "t", {}], ["bot", "Sure"], ["result", "a", { ok: 1 }], ["turn"], ["end", "done"]]);
  });
  assert.ok(s.errors.some((l) => l.includes(`conversation ${id}`) && l.includes("disk full")));
  assert.ok(s.errors.some((l) => l.includes(`conversation ${id}`) && l.includes("disk still full")));
  assert.equal(s.store.isLive(id), false);

  const s2 = setup();
  s2.store.create = () => { throw new Error("read-only"); };
  const r2 = s2.store.recorder({ channel: "voice" }, { error: (...a: unknown[]) => void s2.errors.push(a.join(" ")) });
  assert.doesNotThrow(() => replay(r2, [["user", "Hi"], ["bot", "Hello"], ["turn"], ["end", "done"]]));
  assert.ok(s2.errors.some((l) => l.includes("(not created)") && l.includes("read-only")));
});

test("replay: a normal exchange becomes one user and one assistant entry", () => {
  const { entries } = record([
    ["user", " What"], ["user", " time"], ["user", " is it"], ["user", " in"], ["user", " Tokyo?"],
    ["bot", "It's"], ["bot", " a"], ["bot", " quarter"], ["bot", " past"], ["bot", " seven"], ["bot", " in the"], ["bot", " evening"], ["bot", " in Tokyo."],
    ["turn"],
    ["end", "ended: no follow-up"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "What time is it in Tokyo?" },
    { kind: "assistant", text: "It's a quarter past seven in the evening in Tokyo.", interrupted: false },
  ]);
});

test("replay: barge-in marks the answer interrupted and starts a new user entry with what was said", () => {
  const { entries } = record([
    ["user", " Play"], ["user", " some music."],
    ["bot", "Sure, I can play"], ["bot", " something from your"],
    ["user", " No,"], ["user", " stop."],
    ["interrupted"],
    ["user", " Play the news"], ["user", " instead."],
    ["turn"],
    ["bot", "Okay, playing"], ["bot", " the news."],
    ["turn"],
    ["end", "ended: done"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Play some music." },
    { kind: "assistant", text: "Sure, I can play something from your", interrupted: true },
    { kind: "user", input: "speech", text: "No, stop. Play the news instead." },
    { kind: "assistant", text: "Okay, playing the news.", interrupted: false },
  ]);
});

test("replay: barge-in whose transcription arrives after the interruption", () => {
  const { entries } = record([
    ["user", " Tell me a story."],
    ["bot", "Once upon a time"],
    ["interrupted"],
    ["turn"],
    ["user", " Actually,"], ["user", " never mind."],
    ["bot", "No problem."],
    ["turn"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Tell me a story." },
    { kind: "assistant", text: "Once upon a time", interrupted: true },
    { kind: "user", input: "speech", text: "Actually, never mind." },
    { kind: "assistant", text: "No problem.", interrupted: false },
  ]);
});

test("replay: a late user fragment joins the question when the turn completes without interruption", () => {
  const { entries } = record([
    ["user", " What's"], ["user", " the weather"],
    ["bot", "It's"],
    ["user", " like today?"],
    ["bot", " sunny and"], ["bot", " eighteen degrees."],
    ["turn"],
    ["end", "ended: no follow-up"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "What's the weather like today?" },
    { kind: "assistant", text: "It's sunny and eighteen degrees.", interrupted: false },
  ]);
});

test("replay: a question transcribed entirely after the answer started still comes first", () => {
  const { entries } = record([["bot", "Hello"], ["user", " Hi"], ["user", " Friday."], ["bot", " there!"], ["turn"]]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Hi Friday." },
    { kind: "assistant", text: "Hello there!", interrupted: false },
  ]);
});

test("replay: a tool call mid-turn sits between the assistant text before and after it", () => {
  const { entries } = record([
    ["user", " Play"], ["user", " Dune."],
    ["bot", "Let me"], ["bot", " find it."],
    ["call", "1", "media_play", { query: "Dune" }],
    ["result", "1", { playing: "Dune (2021)" }],
    ["bot", "Playing Dune"], ["bot", " now."],
    ["turn"],
    ["end", "ended: done"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Play Dune." },
    { kind: "assistant", text: "Let me find it.", interrupted: false },
    { kind: "tool", name: "media_play", args: { query: "Dune" }, result: { playing: "Dune (2021)" }, truncated: false },
    { kind: "assistant", text: "Playing Dune now.", interrupted: false },
  ]);
});

test("replay: a tool called before any speech follows the user entry, and a late result still lands in place", () => {
  const { entries } = record([
    ["user", " Set a timer for five minutes."],
    ["call", "1", "set_timer", { minutes: 5 }],
    ["turn"],
    ["bot", "Timer set."],
    ["result", "1", { ok: true }],
    ["turn"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Set a timer for five minutes." },
    { kind: "tool", name: "set_timer", args: { minutes: 5 }, result: { ok: true }, truncated: false },
    { kind: "assistant", text: "Timer set.", interrupted: false },
  ]);
});

test("replay: two concurrent calls to the same tool keep their own results, in call order", () => {
  const { entries } = record([
    ["user", " Turn on the kitchen and the hall lights."],
    ["call", "a", "light_on", { room: "kitchen" }],
    ["call", "b", "light_on", { room: "hall" }],
    ["result", "b", { room: "hall", on: true }],
    ["result", "a", { room: "kitchen", on: true }],
    ["bot", "Both are on."],
    ["turn"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Turn on the kitchen and the hall lights." },
    { kind: "tool", name: "light_on", args: { room: "kitchen" }, result: { room: "kitchen", on: true }, truncated: false },
    { kind: "tool", name: "light_on", args: { room: "hall" }, result: { room: "hall", on: true }, truncated: false },
    { kind: "assistant", text: "Both are on.", interrupted: false },
  ]);
});

test("replay: a tool still running when the session closes is stored without a result", () => {
  const { entries, c } = record([
    ["user", " Search everything."],
    ["call", "1", "search", { q: "*" }],
    ["end", "client closed"],
    ["result", "1", { late: true }],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "speech", text: "Search everything." },
    { kind: "tool", name: "search", args: { q: "*" }, truncated: false },
  ]);
  assert.equal(c!.endReason, "client closed");
});

test("replay: typed and spoken input are distinguished, and typed text during an answer starts the next exchange", () => {
  const { entries } = record([
    ["typed", "pause"],
    ["bot", "Paused."],
    ["typed", "and the lights?"],
    ["turn"],
    ["bot", "They are off."],
    ["turn"],
    ["user", " Play"], ["user", " again."],
    ["bot", "Resuming."],
    ["turn"],
    ["user", " Thanks."],
    ["end", "client closed"],
  ]);
  assert.deepEqual(entries, [
    { kind: "user", input: "text", text: "pause" },
    { kind: "assistant", text: "Paused.", interrupted: false },
    { kind: "user", input: "text", text: "and the lights?" },
    { kind: "assistant", text: "They are off.", interrupted: false },
    { kind: "user", input: "speech", text: "Play again." },
    { kind: "assistant", text: "Resuming.", interrupted: false },
    { kind: "user", input: "speech", text: "Thanks." },
  ]);
});

test("resume appends to an existing thread and makes it active again", () => {
  const s = setup();
  const first = s.store.recorder({ channel: "chat" });
  replay(first, [["typed", "hello"], ["bot", "Hi!"], ["turn"], ["end", "done"]]);
  const id = first.conversationId!;
  assert.equal(s.store.get(id)!.state, "quiet");
  s.clock.advance(60_000);
  const again = s.store.recorder({ channel: "chat" });
  assert.equal(again.resume("nope"), false);
  assert.equal(again.resume(id), true);
  replay(again, [["typed", "one more thing"]]);
  again.assistant("Sure.");
  again.turnComplete();
  assert.equal(s.store.get(id)!.state, "active");
  assert.equal(s.store.delete(id), "live");
  again.end();
  const c = s.store.get(id)!;
  assert.equal(c.state, "quiet");
  assert.deepEqual(c.entries.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(c.preview, "hello");
});

test("chat turn: commitUser stores the message at once; release keeps the thread active and detached", () => {
  const s = setup();
  const r = s.store.recorder({ channel: "chat" });
  r.user("what time is it?", "text");
  assert.equal(r.conversationId, undefined);
  r.commitUser();
  const id = r.conversationId!;
  assert.ok(id, "the conversation exists before any output");
  assert.deepEqual(shape(s.store.get(id)!.entries), [{ kind: "user", input: "text", text: "what time is it?" }]);
  assert.equal(s.store.delete(id), "live");
  r.commitUser(); // nothing held: no duplicate
  r.tool("get_current_time", {}).result({ human: "ten" });
  r.assistant("It is ");
  r.assistant("ten.");
  r.release();
  const c = s.store.get(id)!;
  assert.equal(c.state, "active");
  assert.equal(c.endedAt, null);
  assert.deepEqual(shape(c.entries), [
    { kind: "user", input: "text", text: "what time is it?" },
    { kind: "tool", name: "get_current_time", args: {}, result: { human: "ten" }, truncated: false },
    { kind: "assistant", text: "It is ten.", interrupted: false },
  ]);
  assert.equal(s.store.isLive(id), false);
  r.assistant("late");
  r.release();
  r.end("ignored");
  assert.equal(s.store.get(id)!.entryCount, 3);
  assert.equal(s.store.get(id)!.state, "active");

  // The next turn resumes the thread and appends after it.
  const next = s.store.recorder({ channel: "chat" });
  assert.equal(next.resume(id), true);
  next.user("thanks", "text");
  next.commitUser();
  next.assistant("You're welcome.");
  next.release();
  assert.deepEqual(s.store.get(id)!.entries.map((e) => e.seq), [1, 2, 3, 4, 5]);
});

test("chat turn: a failure after streamed text stores it as interrupted", () => {
  const s = setup();
  const r = s.store.recorder({ channel: "chat" });
  r.user("tell me about Dune", "text");
  r.commitUser();
  r.assistant("Dune is");
  r.interrupted();
  r.release();
  assert.deepEqual(shape(s.store.get(r.conversationId!)!.entries), [
    { kind: "user", input: "text", text: "tell me about Dune" },
    { kind: "assistant", text: "Dune is", interrupted: true },
  ]);
  assert.equal(s.store.isLive(r.conversationId!), false);
});
