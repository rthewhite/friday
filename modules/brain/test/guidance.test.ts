import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidationSystem, entities, extractionFilter, extractionSystem, GUIDANCE_VERSION, LINKING, PAGE_WRITING, SUMMARY, summarySystem, userName } from "../src/nightly/guidance.js";

test("the system prompts are built from the same shared guidance blocks", () => {
  const extraction = extractionSystem("### Raymond (person)\n(empty)", "Raymond");
  const consolidation = consolidationSystem("Raymond");
  const summary = summarySystem("Raymond");
  for (const block of [LINKING, entities("Raymond")]) {
    assert.ok(extraction.includes(block), "extraction has the block");
    assert.ok(consolidation.includes(block), "consolidation has the block");
    assert.ok(summary.includes(block), "the summary has the block");
  }
  assert.ok(extraction.includes(PAGE_WRITING) && consolidation.includes(PAGE_WRITING));
  assert.ok(extraction.includes(extractionFilter("Raymond")));
  assert.ok(!consolidation.includes(extractionFilter("Raymond")));
  assert.ok(summary.includes(SUMMARY) && !consolidation.includes(SUMMARY));
  assert.ok(extraction.endsWith("## The memory\n### Raymond (person)\n(empty)"));
});

test("the guidance states the filter-first rules", () => {
  const filter = extractionFilter("Me");
  assert.match(filter, /empty list of notes is the normal answer/);
  assert.match(filter, /still be true in a month/);
  assert.match(filter, /device or account name/);
  assert.match(filter, /deliberately forgotten/);
  assert.match(PAGE_WRITING, /newer fact wins/);
  assert.match(PAGE_WRITING, /Never invent/);
});

/** The prompt text on one line, so phrase checks don't depend on where it wraps. */
const flat = (text: string) => text.replace(/\s+/g, " ");

test("every named entity gets a page, hobbies get hubs, and the user's page keeps short linked lines", () => {
  const e = flat(entities("Raymond"));
  assert.match(e, /People, places, projects, organisations, hobbies and topics, belongings and pets are entities/);
  assert.match(e, /Every entity the memory names gets its own page, also when it knows nothing about it beyond its name and its relation to the user/);
  assert.match(e, /hub page/);
  assert.match(e, /page of its own once the memory knows more about it than its name/);
  assert.match(e, /"Raymond" is the user's own page/);
  assert.match(e, /\[\[Name\]\] link/);
  assert.match(e, /"Raymond's brother", not "the user's brother"/);
  assert.doesNotMatch(e, /under budget/);
  const consolidation = flat(consolidationSystem("Raymond"));
  assert.match(consolidation, /Move or copy entity detail from "Raymond" to the entity's page/);
  assert.match(consolidation, /The profile is generated separately and is not yours to change/);
  assert.match(consolidation, /Never rename or retype "Raymond", never merge it into another page/);
  assert.doesNotMatch(consolidation, /over budget/);
});

test("while the user's page is still Me, relations say the user", () => {
  assert.equal(userName("Me"), "the user");
  assert.equal(userName("Me 2"), "the user");
  assert.equal(userName("Raymond"), "Raymond");
  assert.equal(userName("Mees"), "Mees");
  assert.match(flat(entities("Me")), /Write relations to the user as "the user's brother": the user's page has no name yet/);
  assert.match(flat(extractionFilter("Me")), /"the user's sister; works at the library\."/);
  assert.match(flat(extractionFilter("Raymond")), /"Raymond's sister; works at the library\."/);
});

test("extraction routes a fact by who or what it is about, also in the first person", () => {
  const filter = flat(extractionFilter("Raymond"));
  assert.match(filter, /named other person, place, project, organisation, hobby, belonging or pet go on that entity/);
  assert.match(filter, /first person/);
  assert.match(filter, /"my Honda needs new tyres" on the Honda's page/);
  assert.match(filter, /about the speaker go on the user's own page \(entity "me"\)/);
  assert.match(filter, /household as a whole go on the household's home page/);
  assert.doesNotMatch(filter, /go on the profile/);
});

test("the summary guidance: derived from the pages, linked, short", () => {
  const s = flat(SUMMARY);
  assert.match(s, /state only what the pages state/);
  assert.match(s, /\[\[Name\]\] link/);
  assert.match(s, /within the token budget given/);
});

test("the guidance version is 3: brains consolidated under older guidance are reconsidered once", () => {
  assert.equal(GUIDANCE_VERSION, 3);
});
