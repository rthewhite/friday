import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { brainText, checkFixture, loadFixtures, seedFixture } from "./nightly/load.js";

const fixtures = loadFixtures();

test("the fixture set covers the cases design D7 lists", () => {
  assert.deepEqual(fixtures.map((f) => f.name), [
    "already-remembered",
    "birthday-in-passing",
    "correction",
    "device-name",
    "dutch",
    "fold-notes",
    "injected-tool-result",
    "media-session",
    "merge-duplicates",
    "no-facts",
    "profile-over-budget",
    "profile-summary",
    "relative-first-person",
    "resumed",
  ]);
  for (const f of fixtures) {
    assert.ok(f.description, `${f.name} has a description`);
    assert.ok(f.kind === "extraction" || f.kind === "consolidation", `${f.name} kind`);
    if (f.kind === "extraction") assert.ok(f.conversation?.entries.length, `${f.name} has a conversation`);
    assert.ok(f.mustNote?.length || f.mustNotNote?.length || f.mustKeep?.length || f.mustNotPage?.length, `${f.name} has expectations`);
  }
});

test("mustNotPage fails when a live page has that name or alias, and passes when none has", async () => {
  const h = await createTestHost(createBrainModule());
  await h.request("POST", "pages", { name: "Mark", type: "person", aliases: ["Markie"] });
  const fx = { name: "t", description: "t", kind: "consolidation" as const, mustNotPage: ["Mark", "markie", "Tim"] };
  assert.deepEqual(checkFixture(h, fx, brainText(h)), [
    { expectation: 'no page named "Mark"', ok: false },
    { expectation: 'no page named "markie"', ok: false },
    { expectation: 'no page named "Tim"', ok: true },
  ]);
});

for (const f of fixtures) {
  test(`fixture ${f.name} parses and seeds a test host`, async () => {
    const h = await createTestHost(createBrainModule(), { env: f.env ?? {} });
    const id = await seedFixture(h, f);
    const names = (h.db.prepare("SELECT name FROM brain__pages WHERE deleted_at IS NULL").all() as { name: string }[]).map((r) => r.name);
    for (const p of f.pages ?? []) assert.ok(names.includes(p.name), `${p.name} seeded`);
    if (f.profile !== undefined) assert.equal((h.db.prepare("SELECT body FROM brain__pages WHERE id = 'profile'").get() as { body: string }).body, f.profile);
    if (f.conversation) {
      const c = await h.conversations.get(id!);
      assert.equal(c?.state, "quiet");
      assert.equal(c?.entries.length, f.conversation.entries.length);
      if (f.conversation.seen) assert.deepEqual(await h.storage.get(`extract:seen:${id}`), { seq: f.conversation.seen });
    }
  });
}
