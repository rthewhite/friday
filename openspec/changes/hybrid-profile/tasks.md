# Tasks

## 1. Profile instructions and the subject page in the store

- [x] 1.1 Add brain migration 3 (`src/schema.ts`): `instructions` on `brain__pages` and `brain__revisions`, `subject_id` on `brain__pages`; create the subject page (`person`, `Me`, or `Me 2`, `Me 3`… when the name is live or tombstoned) with the profile's body as a `system` revision noted `moved from the profile`; set `subject_id`; leave the profile body as is. Verify in `test/schema.test.ts`: an upgraded brain with a non-empty profile, a brain with a live `Me`, a brain with a tombstoned `Me`, and a fresh brain (empty profile, empty subject `Me`)
- [x] 1.2 Extend `Page` and `Revision` in `src/store.ts` with the profile's `instructions` and `subjectId`, add `subject()`, and snapshot the instructions in every profile revision. Verify in `test/store.test.ts` that a profile revision written by any author carries both the body and the unchanged instructions
- [x] 1.3 Add `saveInstructions(base, text)` with author `user`: at most 2000 characters (`invalid` otherwise), stale only when the instructions changed after `base`. Verify in `test/store.test.ts` the "Save instructions", "Summary changed meanwhile", "Instructions changed meanwhile" and "Too long" scenarios
- [x] 1.4 Protect the profile and the subject page: profile body, name, type and aliases refused with `profile` for user saves; subject delete and type change refused with `profile`; subject rename by any author other than `user` refused; user rename keeps the old name as an alias. Verify in `test/store.test.ts` the "Profile is protected", "Subject is protected" and "Rename by the user" scenarios
- [x] 1.5 Run `pnpm --filter @friday/module-brain test` and `pnpm --filter @friday/module-brain typecheck` and verify both pass

## 2. Links added on non-user writes

- [x] 2.1 Add `autolink(text, pages, existingBody)` to `src/links.ts`: first whole-word, case-sensitive occurrence of each live name or alias of 3+ characters, longest first, no overlaps, skipping existing `[[links]]`, inline code, code blocks, names already linked in the body, the written page and the profile. Verify in `test/links.test.ts` the "Lowercase word", "Longest name wins", "Already linked" and "Short name" scenarios plus code spans and existing links
- [x] 2.2 Apply it in the store before writing a revision by `remember`, `extraction` or `consolidation`: on the appended note for `appendNote`, on the whole new body for rewrites, creates, merges and the profile summary; never for `user` or `system`. Verify in `test/store.test.ts` the "Summary mentions a page" and "User's edit untouched" scenarios, and that a user's unlinked mention earlier in a body stays unlinked when `remember` appends
- [x] 2.3 Run the brain module's tests and typecheck and verify both pass

## 3. Tools and the prompt context

- [x] 3.1 Route `brain_remember` in `src/tools.ts` and `appendNote`: `me` and `profile` (case-insensitive) resolve to the subject page; nothing appends to the profile; rewrite the description for people, places, projects, organisations, hobbies, belongings and pets, `me` for the user, and the household's home page for household facts. Verify in `test/tools.test.ts` the "Fact about the user", "Profile fact", "Not writable by tools" and "Description routes facts to entities" scenarios
- [x] 3.2 Verify in `test/tools.test.ts` that `brain_recall` returns the subject page ("Recall about the user") and still never returns the profile, adjusting `src/search.ts` only if it excludes the subject
- [x] 3.3 Rework `src/context.ts`: an instructions block first (only when set, framed as the user's standing instructions that don't change how Friday uses tools or ends conversations, never cut), then the memory intro (the profile is a summary generated from the pages), the summary, and the index; cut the index first, then the summary. Verify in `test/context.test.ts` the "Session opens with memory", "Empty brain", "Many pages", "Profile as a summary", "Instructions come first" and "Instructions are never cut" scenarios
- [x] 3.4 Update the README brain section ("What Friday sees", "How it learns", "Profile budget") and the brain lines of the `openspec/config.yaml` context for instructions, the subject page, `me` routing and auto-linking. Verify that no README line still says facts about you go on the profile
- [x] 3.5 Run the brain module's tests and typecheck and verify both pass

## 4. Pages API

- [x] 4.1 Update `src/routes.ts`: `GET pages` returns the instructions, the subject id and the summary's tokens and budget; `GET pages/:id` and `GET pages/:id/revisions/:revision` include the profile's instructions; `PUT pages/profile` accepts only `instructions` (others refused with `profile`); `POST pages/profile/restore` restores only the instructions; `DELETE` of the subject is refused with `profile`. Verify in `test/routes.test.ts` the "Restore the profile's instructions", "Summary is not editable" and "Subject cannot be deleted" scenarios and the new `GET pages` fields
- [x] 4.2 Update the README `curl` example for `GET pages` and verify it matches a response from the test host
- [x] 4.3 Run the brain module's tests and typecheck and verify both pass

## 5. Nightly extraction and consolidation

- [x] 5.1 Rewrite the guidance in `src/nightly/guidance.ts`: entities include hobbies and topics, belongings and pets; every named entity gets a page (no name-and-relation exemption); hub pages per hobby with item pages once they hold their own facts; facts about the user on the subject page; household facts on the home page; relations written with the subject page's name, or "the user" while it is named `Me`; exact page names in links. Bump `GUIDANCE_VERSION` to 3. Verify in `test/guidance.test.ts` that both system prompts state these rules and use the subject's name
- [x] 5.2 Route extraction in `src/nightly/extract.ts` and `render.ts`: the model gets the subject page's name; notes for the speaker go to the subject. Verify in `test/extract.test.ts` the "Device name", "First-person fact about a relative" and "First-person fact about a belonging" scenarios
- [x] 5.3 Change consolidation in `src/nightly/consolidate.ts`: leave the profile out of the input and the budget header; a guidance change marks the subject page as changed; an empty brain is the profile plus an empty subject; refuse plans that target the profile, rename or retype the subject, or merge it away; drop the over-budget rule. Verify in `test/consolidate.test.ts` the "Guidance changed", "Guidance changed on an empty brain", "The profile is not in the plan's input", "Plan touches the profile", "Subject merged away" and the reworded "Already on the linked page", "Only the name is on the page" and "Not on the named page" scenarios
- [x] 5.4 Replace `profile-over-budget.json` and `profile-summary.json` in `test/fixtures/nightly` with a migrated-subject fixture (brother, employer, motorcycles, RC cars, cats, routine; expected hub, item and stub pages, and links from the subject page), and add a first-person belonging extraction fixture. Verify that `test/nightly-fixtures.test.ts` passes with the fake model
- [x] 5.5 Update the README nightly section (what extraction notes, what consolidation does, guidance changes reconsidering the subject page). Verify that no README line still describes consolidation rewriting the profile
- [x] 5.6 Run the brain module's tests and typecheck and verify both pass

## 6. Summary generation

- [x] 6.1 Add `src/nightly/summary.ts`: trigger on any live page other than the profile changed since the last generated summary (by revision id, including the run's own plan) or a guidance change (own `ctx.storage` keys), an empty summary without a model call for an empty brain, the input (summary guidance, budget, subject and home page in full, other pages up to the bound with subject neighbours first, an index of the rest, the current summary). Verify in a new `test/summary.test.ts` the "Nothing changed" and "Generated after new notes" scenarios and the empty-brain case
- [x] 6.2 Validate the summary (budget, links resolving to live pages, every line backed by the subject page or the pages it names, reusing `preserved` and `namedPages`), with one repair round, and write it as a `consolidation` profile revision keeping the instructions. Verify in `test/summary.test.ts` the "Unbacked line", "Over budget", "Dangling link" and "Refused twice" scenarios
- [x] 6.3 Run the summary after consolidation in `src/nightly/job.ts`; record whether it was generated and count the profile among the touched pages in `src/nightly/runs.ts`; a profile revert restores only the summary and is stale only on a later summary change. Verify in `test/nightly.test.ts`, `test/runs.test.ts` and `test/runs-routes.test.ts` the "Summary", "Revertible" and "Revert a summary" scenarios
- [x] 6.4 Add summary fixtures (a backed, linked summary within budget; a brain whose detail would exceed the budget) and extend `scripts/eval.ts` to report "Profile split checked" and "Summary checked". Verify that `test/nightly-fixtures.test.ts` passes and that `pnpm --filter @friday/module-brain eval` lists the new fixtures
- [x] 6.5 Update the README nightly section and the `openspec/config.yaml` brain context for the summary step, and the `.env.example` comment on `BRAIN_PROFILE_TOKEN_BUDGET` (now the summary's target). Verify that the documented behaviour matches the tests
- [x] 6.6 Run the brain module's tests and typecheck and verify both pass

## 7. Portal

- [x] 7.1 Update `src/ui/BrainPage.vue` and `src/ui/lib/pages.ts`: the profile pinned first with the summary's tokens against the budget, the subject page second marked as the user's page, with a prompt to name it while it is `Me`. Verify the list ordering and the name prompt in `test/ui-lib.test.ts`
- [ ] 7.2 Update `src/ui/PageView.vue` for the profile: an instructions editor with the stale handling, the summary rendered read-only with its links and generation time, and `Run nightly now` calling `POST /api/jobs/brain/nightly/run` (409 shown as already running); no `Delete` for the profile and the subject page, type fixed for the subject. Verify in the running portal (`FRIDAY_PORT=8081 FRIDAY_CORE_URL=http://localhost:8081 pnpm dev`) the "Edit instructions" and "Summary links" scenarios, then stop the dev server
- [ ] 7.3 Show the instructions and the summary in the profile's history diff and offer `Restore these instructions`; show the profile's summary diff in the `Nightly` tab. Verify the "Undo an instructions edit" scenario in the running portal, then stop the dev server
- [x] 7.4 Update the README "Curating" paragraph for instructions, the read-only summary, the subject page and `Run nightly now`. Verify it matches the portal
- [x] 7.5 Run `pnpm --filter @friday/module-brain test` and `typecheck` and verify both pass

## 8. Integration

- [x] 8.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` and verify all pass
- [x] 8.2 Upgrade a local brain whose profile holds the text of the migrated-subject fixture from 5.4: start the dev server, verify the subject page `Me` holds the old profile, run `brain/nightly` from the portal, and review in the `Nightly` tab that hub, item and stub pages were created, the subject page links them, and the summary is backed and linked. Stop the dev server
- [x] 8.3 Run `pnpm --filter @friday/module-brain eval` against `FRIDAY_TEXT_MODEL` and verify the extraction, consolidation and summary fixtures pass, recording any failures with their output
- [ ] 8.4 After deployment (user): rename `Me` in the portal, add instructions, run nightly now, and review the result in the `Nightly` tab
