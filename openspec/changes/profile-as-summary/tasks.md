# Tasks

## 1. Guidance: the profile as a summary, facts routed to entities

- [x] 1.1 In `modules/brain/src/nightly/guidance.ts`, make these edits per design D1 and D4, and export `GUIDANCE_VERSION = 2`, with a comment on when to bump it:
  - rewrite `PROFILE` as a summary backed by entity pages, with the "beyond name and relation" threshold, the `[[link]]` line, and facts allowed in both places;
  - reword `CONSOLIDATION_ROLE`'s `rewrite`/`create` bullets to move or copy entity detail off the profile whatever the budget;
  - replace `EXTRACTION_FILTER`'s "me/I" rule with routing by who a fact is about, with the relation in the fact.

  Verify with `test/guidance.test.ts`:
  - both prompts carry the new `PROFILE` block;
  - the consolidation prompt no longer limits `create` to an over-budget profile;
  - the extraction prompt states the first-person routing rule.
- [x] 1.2 Update `brain_remember`'s description in `src/tools.ts` (design D4). Verify with `test/tools.test.ts`: the description routes facts about a named person, place, project or organisation to that entity, also in the first person, and reserves `profile` for the user or the household as a whole.
- [x] 1.3 Add the profile-summary sentence to `INTRO` in `src/context.ts` (design D5). Verify with `test/context.test.ts`: the context says the profile is a summary with details on the pages, also for an empty brain, and the existing size-bound tests still pass.

## 2. Consolidation: guidance trigger and named-page loss check

- [x] 2.1 In `src/nightly/consolidate.ts`, implement the guidance version trigger (design D2):
  - read `consolidate:guidance` (absent = 1);
  - when it is older, add the profile to `changed` and add the "guidance changed" header line;
  - store `GUIDANCE_VERSION` after an applied plan, an empty one included;
  - store it without a model call when the brain holds only an empty profile.

  Verify with `test/consolidate.test.ts`:
  - an older version with no page changes calls the model with the profile marked `(changed)`;
  - after the plan is applied, the next run makes no call;
  - a plan refused twice leaves the version older, so the run after calls again;
  - an empty brain records the version with no call;
  - the existing "no model call when no page changed" test sets the current version and still passes.
  - It passes unchanged: its empty brain records the version without a call, and its seeded brain records it with the first applied plan. A separate test checks that an input without an older version has no guidance line.
- [x] 2.2 Extend `validatePlan`'s loss check (design D3): a removed line also counts as preserved when a live page it names (`[[link]]`, or name/alias as whole words), other than its own page and not touched or merged away by the plan, states most of its significant words. Verify with `consolidate.test.ts`:
  - "Already on the linked page" is applied;
  - "Not on the named page" is refused, naming the profile and the line;
  - a line naming no page is still refused as before;
  - a match only on an unrelated page doesn't count.

## 3. Fixtures and eval

- [ ] 3.1 Add an optional `mustNotPage: string[]` field to the fixture format in `test/nightly/load.ts`, checked by `checkFixture` (no live page has that name or alias). Verify with a `nightly-fixtures.test.ts` case where a seeded page fails the check and a missing one passes.
- [ ] 3.2 Add `test/fixtures/nightly/relative-first-person.json` (extraction) and `profile-summary.json` (consolidation) per design D6, with fake answers. List both in the coverage test in `nightly-fixtures.test.ts`. Verify with `pnpm --filter @friday/module-brain test`: both fixtures pass against the fake model, and the `profile-summary` fake plan passes `validatePlan`.
- [ ] 3.3 Run `pnpm --filter @friday/module-brain eval relative-first-person profile-summary fold-notes profile-over-budget` against the real model, and verify that each expectation passes. Where one fails, tune the guidance from 1.1, then re-run the guidance and fixture tests and the eval. Record the eval result in the commit message.

## 4. Docs

- [ ] 4.1 Update `README.md`'s Memory section and verify it states:
  - the profile is a summary and detail lives on entity pages;
  - first-person facts about named others go to their page (the extraction bullet);
  - consolidation creates entity pages whatever the budget;
  - a guidance change reconsiders the profile once, with `Run now` to do it right away.
- [ ] 4.2 Update the brain part of the `openspec/config.yaml` context (profile as a summary, the guidance version in `ctx.storage`, the named-page loss check). Verify that `openspec validate profile-as-summary --strict` passes.

## 5. Integration

- [ ] 5.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree and verify that all three succeed.
