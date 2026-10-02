# Design

## Context

The nightly pass (`modules/brain/src/nightly/`) works in two steps. Extraction appends dated notes, the same way `brain_remember` does. Consolidation then asks the model for one validated plan over the whole brain. Both system prompts are built from the shared blocks in `guidance.ts`. Three parts of the current guidance send everything to the profile:

- `EXTRACTION_FILTER` says facts about "me" or "I" go on the profile.
- The `PROFILE` block says the profile holds "the household's members".
- `CONSOLIDATION_ROLE` offers `create` only "to move detail off an over-budget profile".

`brain_remember`'s description (`tools.ts`) says the same as the extraction rule.

Two pieces of the current mechanics shape this design:

- **Change trigger.** `runConsolidate` runs only when `changesSince(watermark)` is non-empty. A brain that was already consolidated under the old guidance is never looked at again until a page changes.
- **Loss check.** `validatePlan` counts a removed line as kept only when its words occur in the bodies of the plan's own actions. To trim the profile, the plan therefore has to repeat facts that an untouched entity page already states, or declare them as dropped.

## Goals / Non-Goals

**Goals:**
- After one run, an existing profile that holds entity detail is split into pages, with no manual editing.
- The loss check stays strict about facts that really disappear.

**Non-Goals:**
- Splitting by hard rules. Whether a line is "about an entity" is left to the model, guided by the prompt and measured with fixtures.
- Changing the profile budget or how the prompt context is cut.
- New portal UI. Review and revert in the `Nightly` tab already cover this.

## Decisions

### D1. Steer with guidance, not a validator rule

Rewrite the `PROFILE` block as follows:
- The profile is a short summary: who the user is, household members and close relations by name and relation, and standing preferences.
- Any person, place, project or organisation with a fact beyond its name and relation gets its own page, whatever the budget.
- The profile keeps at most a short line about it, with a `[[link]]`.
- A fact may be on both.

`CONSOLIDATION_ROLE`'s `create` and `rewrite` bullets gain "move or copy entity detail from the profile to the entity's page", and lose the over-budget-only framing. The over-budget rule (never grow the profile) stays as it is.

*Alternative:* a validator rule that refuses a profile line naming an entity that has facts. That would mean telling relations ("Wife: [[Lisa]]") from detail mechanically, which is brittle and would refuse good plans. *Alternative:* lower the default budget. That would trim the profile but still create no pages.

### D2. A guidance version makes existing brains reconsidered once

`guidance.ts` exports `GUIDANCE_VERSION = 2`; an absent value counts as 1. A comment there says to bump it whenever a guidance change should make existing brains be reconsidered. `runConsolidate` reads `consolidate:guidance` from `ctx.storage`:

- **Version is older:** the profile is added to `changed`, even when `changesSince` is empty. The input header gains one line: "The guidance changed since the last tidy-up; check the profile against it."
- **Plan applied:** the version is stored right after the watermark, and an empty plan counts too. When the plan is refused twice or the model is unavailable, nothing is stored, so the next run tries again.
- **Empty brain:** a brain that holds only an empty profile has nothing to reconsider. The version is stored without a model call, so a fresh install doesn't spend a call on its first night.

The watermark logic is unchanged. Marking the profile as changed only adds it to the set; it never moves the revision watermark.

*Alternative:* reset the revision watermark to 0. That marks every page as changed and makes the prompt and the plan larger. It also invites rewrites of pages the user curated by hand. *Alternative:* a module migration. Migrations can only touch `brain__*` tables, not `module_kv`, and a data change there wouldn't express "reconsider". *Alternative:* a "reconsolidate" button. That needs UI and a route, and a later guidance change would need the user to remember to press it.

### D3. The loss check also looks at the pages a line names

In `lossCheck`, a removed line that isn't preserved in the plan's result text gets one more chance. It counts as kept when `preserved(line, words)` holds for the text of a page the line names. Such a page:

- is named by a `[[link]]` in the line, resolved with `store.resolve`, or by its name or an alias appearing in the line as whole words (folded, like `search.ts`);
- is live, isn't the page the line came from, and isn't touched or merged away by the plan. A touched page's new body is already in the result text.

`validatePlan` builds the list of name keys once per call. The brain is small, hundreds of pages at most, so a scan per removed line is cheap.

*Alternative:* count the whole brain as the result. That makes the check laxer as the brain grows. A line's significant words would almost always show up somewhere, which defeats the check. Limiting it to the named pages keeps "the fact is still there" precise.

### D4. Route facts by who they're about, in extraction and `brain_remember`

`EXTRACTION_FILTER`'s profile rule becomes:
- facts about the speaker go on the profile;
- facts about a named other person, place, project or organisation go on that entity, also in the first person, with the relation in the fact ("The user's wife; teaches at De Regenboog.");
- facts about the household as a whole go on the profile.

`brain_remember`'s description gets the same rule.

Extraction doesn't also write a profile line. Keeping the profile summary up to date is consolidation's job (D1), which avoids two notes for one fact. Until consolidation runs, Friday still sees the new page in the prompt's page index.

### D5. The prompt context says the profile is a summary

`INTRO` in `context.ts` gains one sentence: "The profile is a summary; details about the people, places and projects it names are on their pages (brain_recall)." The size bound and the order in which things are cut are unchanged.

### D6. Fixtures

- `relative-first-person.json` (extraction): "my wife Lisa teaches at De Regenboog, and I'm an engineer at Schuberg Philis". It expects a note on `Lisa` containing "Regenboog", and one on `Schuberg Philis` or the profile containing "engineer". `mustNotNote` covers nothing on the profile about De Regenboog.
- `profile-summary.json` (consolidation): a profile under budget whose notes are about Lisa, Tim and Schuberg Philis, plus "Has a brother, Mark", and no other pages. It expects:
  - pages `Lisa`, `Tim` and `Schuberg Philis` holding their facts;
  - a profile that still names each of them;
  - no page for `Mark`.

  The fake plan creates the pages and rewrites the profile.
- The coverage test in `nightly-fixtures.test.ts` lists both new cases.

The `mustNote` check already works on any page after the run, so consolidation fixtures can use it. Saying "no page named X" needs one new optional fixture field, `mustNotPage: string[]`. `checkFixture` passes it when no live page has X as its name or alias.

## Risks / Trade-offs

- [The model over-splits, creating a page for every name mentioned in passing] → the guidance threshold is "a fact beyond its name and relation", every page is reviewable and revertible in the `Nightly` tab, and the fixtures include a case that must not create a page.
- [The model still keeps detail on the profile, since this is guidance and not a rule] → `pnpm --filter @friday/module-brain eval profile-summary relative-first-person` measures it against the real model before merge. After deploy, `Run now` on the homelab shows the result directly.
- [D3 lets a line pass when its words happen to be on a page it names but mean something else] → the risk is limited to pages the line itself names, and needs 60% of its significant words, the same threshold as today.
- [The one-off run costs a model call on every existing install] → one call per guidance bump, and none for an empty brain.

## Migration Plan

1. Deploy as usual (merge to `main`).
2. On the homelab, open Jobs and click `Run now` on `brain/nightly`, or wait until 03:00. The run sees guidance version 1 < 2, consolidates with the profile marked as changed, and should create the entity pages.
3. Review the run in the brain's `Nightly` tab, and revert any page that came out wrong.

Rollback: revert the change. The stored `consolidate:guidance = 2` is then ignored by the old code, and the pages created stay, as ordinary pages.
