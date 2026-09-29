import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidationSystem, extractionSystem, EXTRACTION_FILTER, LINKING, PAGE_WRITING, PROFILE } from "../src/nightly/guidance.js";

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
