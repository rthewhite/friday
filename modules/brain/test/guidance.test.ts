import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidationSystem, extractionSystem, EXTRACTION_FILTER, GUIDANCE_VERSION, LINKING, PAGE_WRITING, PROFILE } from "../src/nightly/guidance.js";

test("both system prompts are built from the same shared guidance blocks", () => {
  const extraction = extractionSystem("## Profile\n(empty)");
  const consolidation = consolidationSystem();
  for (const block of [PAGE_WRITING, LINKING, PROFILE]) {
    assert.ok(extraction.includes(block), "extraction has the block");
    assert.ok(consolidation.includes(block), "consolidation has the block");
  }
  assert.ok(extraction.includes(EXTRACTION_FILTER));
  assert.ok(!consolidation.includes(EXTRACTION_FILTER));
  assert.ok(extraction.endsWith("## The memory\n## Profile\n(empty)"));
});

test("the guidance states the filter-first rules", () => {
  assert.match(EXTRACTION_FILTER, /empty list of notes is the normal answer/);
  assert.match(EXTRACTION_FILTER, /still be true in a month/);
  assert.match(EXTRACTION_FILTER, /device or account name/);
  assert.match(EXTRACTION_FILTER, /deliberately forgotten/);
  assert.match(PAGE_WRITING, /newer fact wins/);
  assert.match(PAGE_WRITING, /Never invent/);
});

/** The prompt text on one line, so phrase checks don't depend on where it wraps. */
const flat = (text: string) => text.replace(/\s+/g, " ");

test("the profile is a summary backed by entity pages, whatever the budget", () => {
  const profile = flat(PROFILE);
  assert.match(profile, /short summary/);
  assert.match(profile, /beyond its name and its relation to the user/);
  assert.match(profile, /own page, also when the profile is under budget/);
  assert.match(profile, /\[\[Name\]\]/);
  assert.match(profile, /both/);
  const consolidation = flat(consolidationSystem());
  assert.match(consolidation, /move or copy entity detail from the profile/i);
  assert.doesNotMatch(consolidation, /create: a new page, for example to move detail off an over-budget profile/, "create is not limited to an over-budget profile");
  assert.match(consolidation, /over budget/, "the rule that an over-budget profile must not grow stays");
});

test("extraction routes a fact by who it is about, also in the first person", () => {
  const filter = flat(EXTRACTION_FILTER);
  assert.match(filter, /named other person, place, project or organisation go on that entity/);
  assert.match(filter, /first person/);
  assert.match(filter, /relation to the user/);
  assert.match(filter, /about the speaker go on the profile/);
  assert.doesNotMatch(filter, /Facts about "me" or "I" go on the profile, unless/);
});

test("the guidance version is 2: brains consolidated under version 1 are reconsidered once", () => {
  assert.equal(GUIDANCE_VERSION, 2);
});
