# Tasks

Prerequisite: `brain` is merged into `main` (store with `writeRevision`, `appendNote`, links, search, routes, UI with line diff).

## 1. Run record and job skeleton

- [x] 1.1 Add brain migration 2 (`brain__runs` per design D1), and a run-record helper to start and finish runs with counts, dropped lines, merges, the revision range and the error. Verify with `modules/brain/test/runs.test.ts`: a started and finished run round-trips, and `first_revision_id`/`last_revision_id` bracket the revisions written in between
- [x] 1.2 Schedule `nightly` from `BRAIN_NIGHTLY_CRON` (default `0 3 * * *`, `off` skips it, `timeoutMs` 30 min) with a handler that runs extract, then consolidate, finishes the run row and returns the summary. Add both keys to the manifest config. Verify with `test/nightly.test.ts` via `createTestHost`: `host.jobs` shows the cron, `off` registers nothing, and `runJob` on an empty brain returns `ok` with a zero-count summary

## 2. Shared guidance and fixtures

- [ ] 2.1 Write `src/nightly/guidance.ts` (`PAGE_WRITING`, `LINKING`, `PROFILE`, `EXTRACTION_FILTER`) per design D5 and the spec's filter rules. Verify with a test asserting both system prompts include the shared blocks, so they can't drift
- [ ] 2.2 Add the fixture format and loader (`test/fixtures/nightly/*.json`: seeded pages, conversation entries, `mustNote`, `mustNotNote`, `mustKeep`, `mayDrop`), and the fixtures listed in design D7. Verify with a loader test that every fixture parses and seeds a test host

## 3. Extraction

- [ ] 3.1 Implement the transcript rendering:
  - `[earlier]`/`[new]` split at `seen.seq`;
  - spoken or typed and interrupted markers;
  - tool calls without results, and `brain_remember` shown as already remembered;
  - channel, device and date header;
  - the brain rendering with dangling and tombstoned names and the 60000-character bound with search-ranked full bodies.

  Verify with `test/extract.test.ts`:
  - the injected-tool-result fixture's result text is absent from the request;
  - only new entries are marked `[new]`;
  - an oversized brain is bounded with the most relevant pages in full.
- [ ] 3.2 Implement extraction per conversation: the schema (`notes`, at most 10), the `generate` call (`standard`, `temperature` 0.2), and notes applied through `appendNote` with author `extraction` and the conversation as source (refusals counted), dated with the day of the conversation's last activity in `FRIDAY_TIMEZONE` (extend `appendNote` with author and sources). Verify with `extract.test.ts` using the fake LLM: fact-in-passing adds a sourced note, a tombstoned entity is refused and counted, existing text is untouched, a fact `brain_remember` stored during the conversation (followed by another note the same day) is skipped by a run after midnight, and a conversation extracted twice adds its notes once
- [ ] 3.3 Implement watermark and progress in `ctx.storage`:
  - retries first, then `list({ quietSince })` up to `BRAIN_NIGHTLY_MAX_CONVERSATIONS`;
  - the trivial skip (fewer than 4 user words);
  - `seen.seq` and watermark advanced per conversation;
  - `invalid_output`/`blocked` → retry key, given up at 3;
  - `unavailable`/`cancelled` → stop without advancing, run `partial`;
  - deleted conversations dropped, and `seen` keys pruned.

  Verify with `extract.test.ts` cases for:
  - backlog 70 → 30/30/10 over three runs;
  - a resumed conversation extracting only new entries;
  - a trivial skip with no model call;
  - an invalid answer retried next run and given up after 3;
  - a quota error stopping with the same conversation next time.

## 4. Consolidation

- [ ] 4.1 Implement the trigger (pages changed since `consolidate:last_revision_id` by other authors), the input rendering (revisions, `(changed)` marks, budget, tombstones, the bound prioritising changed pages and their link neighbours) and the plan schema (at most 20 actions, `note`). Verify with `test/consolidate.test.ts`: no model call when nothing changed, and changed pages marked in the request
- [ ] 4.2 Implement plan validation, including the undeclared-loss check (removed lines, preserved at 60% or more of significant words, or declared). Verify with `consolidate.test.ts` cases for each refusal:
  - stale base;
  - unknown or deleted page;
  - empty body;
  - profile rename or merge;
  - tombstoned name;
  - a larger over-budget profile;
  - the wifi-line undeclared loss;
  - a declared supersession passing;
  - a rephrasing that keeps its words passing.
- [ ] 4.3 Implement application in one `ctx.db.transaction` (rewrite, create, and merge with the alias union and soft delete of `from`), the single repair call with the refusal reasons, and `consolidate:last_revision_id` advancing only on success. Verify with `consolidate.test.ts`:
  - a merge makes `[[Noukie]]` resolve to `Anouk`;
  - a store error in the third action leaves the first two unapplied;
  - a first refused and repaired plan is applied;
  - a plan refused twice writes nothing and the run is `partial`.

## 5. Review and revert

- [ ] 5.1 Add the routes `GET runs`, `GET runs/:id` (pages touched with pre-run and last revisions, dropped lines, merges, source conversations marked gone via `ctx.conversations.get`) and `POST runs/:id/pages/:pageId/revert` (restore, soft-delete a created page, undelete a merge's `from`, one transaction, 409 `stale`). Verify with `test/runs-routes.test.ts` via `host.request`: review shape, revert of a rewrite, revert of a merge restoring `Noukie`, revert of a created page, stale 409, and a gone source
- [ ] 5.2 Add the `Nightly` tab to the brain UI: a runs table (time, trigger, outcome, summary), and a run view with a per-page diff from the brain's line diff, dropped lines with reasons, source links (gone marked), `Revert` with the stale fallback to open the page, and an empty state linking to `/settings/jobs`. Verify `pnpm --filter @friday/portal build` passes, then in `pnpm dev` seed a run through `Run now` on the Jobs page (with a real key) and revert one page

## 6. Eval, docs and integration

- [ ] 6.1 Add `scripts/eval.ts` and the `eval` script: fixtures through `createTestHost` with an `llm` function calling Gemini via `@google/genai` (dev dependency) with `responseJsonSchema`, using `GEMINI_API_KEY` and `FRIDAY_TEXT_MODEL`, printing pass or fail per expectation. Verify by running it with a real key and recording the results for `gemini-flash-latest` in the PR description. Tune the loss threshold and trivial cut-off only if the fixtures demand it
- [ ] 6.2 Document the nightly pass in the README (what it reads and never reads, notes then consolidation, declared drops, the `Nightly` tab and revert, cost, the recommended stronger `FRIDAY_TEXT_MODEL`, the eval command) and `BRAIN_NIGHTLY_CRON` / `BRAIN_NIGHTLY_MAX_CONVERSATIONS` in `.env.example`. Verify the documented eval command runs as written
- [ ] 6.3 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree and verify all pass
- [ ] 6.4 End-to-end on a local core with a real key:
  - hold two chat conversations that mention lasting facts without asking to remember;
  - let them go quiet (`FRIDAY_CONVERSATION_QUIET_MINUTES=1`);
  - `Run now` on `brain/nightly`;
  - verify notes were added with sources, consolidation folded them, and the `Nightly` tab shows the run and can revert a page.
