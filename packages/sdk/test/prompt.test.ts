import { test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt, PromptContext } from "../src/index.js";

function capture() {
  const lines: { level: "log" | "warn" | "error"; text: string }[] = [];
  const push = (level: "log" | "warn" | "error") => (...a: unknown[]) => void lines.push({ level, text: a.join(" ") });
  return { lines, log: { log: push("log"), warn: push("warn"), error: push("error") } };
}

test("modules render in the order they got a slot, providers in registration order", () => {
  const p = new PromptContext({ log: capture().log });
  const brain = p.forOwner("brain");
  const media = p.forOwner("media");
  media.addContext(() => "## Media\nNow playing: nothing");
  brain.addContext(() => "  ## Brain\nThe user is Ray.  ");
  brain.addContext(() => "Profile updated yesterday.");
  assert.equal(p.render("voice"), "## Brain\nThe user is Ray.\n\nProfile updated yesterday.\n\n## Media\nNow playing: nothing");
});

test("empty and undefined output is skipped", () => {
  const p = new PromptContext({ log: capture().log });
  const a = p.forOwner("a");
  a.addContext(() => undefined);
  a.addContext(() => "   \n");
  p.forOwner("b").addContext(() => "b");
  assert.equal(p.render("chat"), "b");
  assert.equal(new PromptContext().render("chat"), "");
});

test("providers receive the channel and may answer per channel", () => {
  const p = new PromptContext();
  p.forOwner("brain").addContext(({ channel }) => (channel === "chat" ? "Full index" : undefined));
  assert.equal(p.render("chat"), "Full index");
  assert.equal(p.render("voice"), "");
});

test("a module's combined context is cut at the cap with … and a warning", () => {
  const { lines, log } = capture();
  const p = new PromptContext({ log });
  p.forOwner("brain").addContext(() => "x".repeat(20000));
  p.forOwner("media").addContext(() => "short");
  const out = p.render("voice");
  const [brain, media] = out.split("\n\n");
  assert.equal(brain.length, 12000);
  assert.ok(brain.endsWith("x…"));
  assert.equal(media, "short");
  assert.deepEqual(lines, [{ level: "warn", text: "prompt context from brain is 20000 characters; cut to 12000" }]);
  const small = new PromptContext({ maxChars: 10, log });
  small.forOwner("m").addContext(() => "0123456789ABC");
  assert.equal(small.render("chat"), "012345678…");
  // The cut never splits a surrogate pair.
  const emoji = new PromptContext({ maxChars: 10, log });
  emoji.forOwner("m").addContext(() => "01234567🐝 and more");
  assert.equal(emoji.render("chat"), "01234567…");
});

test("a throwing provider is logged with its module and skipped", () => {
  const { lines, log } = capture();
  const p = new PromptContext({ log });
  p.forOwner("brain").addContext(() => { throw new Error("no such table"); });
  p.forOwner("brain").addContext(() => "still here");
  p.forOwner("media").addContext(() => "media");
  assert.equal(p.render("voice"), "still here\n\nmedia");
  assert.deepEqual(lines, [{ level: "error", text: "prompt context provider of brain failed: no such table" }]);
});

test("an async provider is skipped with a warning", async () => {
  const { lines, log } = capture();
  const p = new PromptContext({ log });
  p.forOwner("brain").addContext((async () => { throw new Error("later"); }) as unknown as () => string);
  assert.equal(p.render("voice"), "");
  assert.match(lines[0].text, /provider of brain returned a promise and was skipped/);
  await new Promise((r) => setImmediate(r));
});

test("a provider slower than 100 ms is logged with its duration", () => {
  const { lines, log } = capture();
  let t = 0;
  const p = new PromptContext({ log, now: () => t });
  p.forOwner("brain").addContext(() => { t += 250; return "slow"; });
  p.forOwner("media").addContext(() => { t += 100; return "fast enough"; });
  assert.equal(p.render("voice"), "slow\n\nfast enough");
  assert.deepEqual(lines, [{ level: "warn", text: "prompt context provider of brain took 250 ms" }]);
});

test("addContext returns an unsubscribe; clear removes a module's providers but keeps its place", () => {
  const p = new PromptContext();
  const brain = p.forOwner("brain");
  p.forOwner("media").addContext(() => "media");
  const same = () => "brain";
  const off = brain.addContext(same);
  brain.addContext(same);
  off();
  assert.equal(p.render("voice"), "brain\n\nmedia");
  off();
  assert.equal(p.render("voice"), "brain\n\nmedia");
  p.clear("brain");
  assert.equal(p.render("voice"), "media");
  brain.addContext(() => "brain again");
  assert.equal(p.render("voice"), "brain again\n\nmedia");
});

test("composePrompt appends context after a blank line, and only when there is some", () => {
  assert.equal(composePrompt("base\n\nvoice", "## Brain"), "base\n\nvoice\n\n## Brain");
  assert.equal(composePrompt("base\n\nvoice", ""), "base\n\nvoice");
});
