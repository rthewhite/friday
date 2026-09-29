import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { CONTEXT_MAX } from "../src/context.js";
import { estimateTokens, hint } from "../src/text.js";

async function host() {
  let t = Date.parse("2026-09-29T08:00:00Z");
  const h = await createTestHost(createBrainModule({ now: () => new Date((t += 1000)) }));
  const post = async (b: Record<string, unknown>) => (await h.request("POST", "pages", b)).body as { id: string; revisionId: number };
  const setProfile = async (body: string) => {
    const cur = (await h.request("GET", "pages/profile")).body as { revisionId: number };
    const r = await h.request("PUT", "pages/profile", { name: "Profile", type: "other", aliases: [], body, baseRevision: cur.revisionId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  return { h, post, setProfile };
}

test("the context holds the profile and an index line per page, the same for voice and chat", async () => {
  const { h, post, setProfile } = await host();
  await setProfile("Lives in Amsterdam.\nWorks from home.");
  await post({ name: "Anouk", type: "person", aliases: ["Noukie"], body: "## About\n**Sister**, lives in [[Utrecht]]\n\n## Notes\n- 2026-09-29: Birthday 3 November" });
  await post({ name: "Car", type: "other" });
  const voice = h.promptContext("voice");
  assert.equal(h.promptContext("chat"), voice);
  assert.match(voice, /^## Memory\nYou have a long-term memory/);
  assert.match(voice, /### Profile\nLives in Amsterdam\.\nWorks from home\.\n/);
  // Most recently updated first; the hint is the first line of text without markdown.
  assert.match(voice, /### Pages\nCall brain_recall before answering about any of these[^\n]*\n[^\n]*\n- Car \(other\)\n- Anouk \(person; aka Noukie\): Sister, lives in Utrecht\n/);
  assert.match(voice, /the newer one holds/);
  assert.match(voice, /call brain_remember\.$/);
});

test("an empty brain still tells the model about brain_remember", async () => {
  const { h } = await host();
  const text = h.promptContext("voice");
  assert.match(text, /### Profile\n\(empty\)/);
  assert.match(text, /### Pages\n\(no pages yet\)/);
  assert.match(text, /call brain_remember/);
  assert.doesNotMatch(text, /more; brain_recall/);
});

test("with 80 pages the index lists the 50 most recent and says there are 30 more", async () => {
  const { h, post } = await host();
  for (let i = 1; i <= 80; i++) await post({ name: `Page ${i}`, body: `Hint ${i}` });
  const text = h.promptContext("chat");
  const lines = text.split("\n").filter((l) => l.startsWith("- Page "));
  assert.equal(lines.length, 50);
  assert.equal(lines[0], "- Page 80 (other): Hint 80");
  assert.equal(lines[49], "- Page 31 (other): Hint 31");
  assert.match(text, /- …and 30 more; brain_recall finds them by search\./);
});

test("an oversized brain stays under 10000 characters: index entries go first, then the profile is cut at a line", async () => {
  const { h, post, setProfile } = await host();
  for (let i = 1; i <= 50; i++) await post({ name: `Person ${i}`, type: "person", aliases: [`P${i}`], body: `${"A long first line. ".repeat(4)}` });
  await setProfile(Array.from({ length: 200 }, (_, i) => `- Fact ${i}: ${"x".repeat(50)}`).join("\n"));
  const text = h.promptContext("voice");
  assert.ok(text.length <= CONTEXT_MAX, `${text.length}`);
  assert.doesNotMatch(text, /- Person \d+ \(person/);
  assert.match(text, /- …and 50 more/);
  assert.match(text, /\(…profile cut here; the full text is in the portal\)/);
  // Cut at a line boundary: the last kept line is complete.
  const profile = text.split("### Profile\n")[1]!.split("\n(…profile cut")[0]!;
  assert.match(profile.split("\n").at(-1)!, /^- Fact \d+: x{50}$/);
  assert.match(text, /call brain_remember\.$/);

  // A big index alone only loses entries.
  const small = await host();
  await small.setProfile("Short profile");
  for (let i = 1; i <= 50; i++) await small.post({ name: `Page ${i} ${"n".repeat(60)}`, aliases: Array.from({ length: 3 }, (_, j) => `alias ${i}-${j} ${"a".repeat(30)}`), body: "b".repeat(90) });
  const t2 = small.h.promptContext("voice");
  assert.ok(t2.length <= CONTEXT_MAX);
  assert.match(t2, /### Profile\nShort profile\n/);
  const listed = t2.split("\n").filter((l) => l.startsWith("- Page ")).length;
  assert.ok(listed > 0 && listed < 50, `${listed}`);
  assert.match(t2, new RegExp(`- …and ${50 - listed} more`));
});

test("deleted pages are not listed", async () => {
  const { h, post } = await host();
  const gone = await post({ name: "Old car" });
  await post({ name: "New car" });
  await h.request("DELETE", `pages/${gone.id}`);
  const text = h.promptContext("voice");
  assert.match(text, /- New car/);
  assert.doesNotMatch(text, /Old car/);
});

test("the profile token estimate is characters / 4, rounded up; hints strip markdown", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(hint("# Title\n\n> **Sister** of [[Anouk]], see [site](http://x)"), "Sister of Anouk, see site");
  assert.equal(hint("## Notes\n- 2026-09-29: Birthday"), "2026-09-29: Birthday");
  assert.equal(hint("x".repeat(100)).length, 80);
  assert.equal(hint("## Only a heading"), "");
});
