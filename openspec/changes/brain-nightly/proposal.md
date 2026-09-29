# Proposal

## Why

`brain_remember` only appends (see `brain`), so pages collect `## Notes` lines, duplicates and contradicting facts. Facts said in passing, that Friday was never asked to remember, don't get stored at all. A nightly pass fixes both. It reads the conversations that finished since the last run for lasting facts, then tidies the brain: it folds notes into pages, dedupes, merges pages about the same thing and adds links. Its changes apply directly, and any of them is easy to review and undo.

## What Changes

- New job **`brain/nightly`** (`BRAIN_NIGHTLY_CRON`, default `0 3 * * *`, `off` disables it) that runs two steps in order. Each run is recorded in the brain with its counts and the revisions it wrote, and it returns a summary such as `5 conversations (2 trivial), 4 notes; 3 pages rewritten, 1 merge, 2 lines dropped`.
- **Step 1: extract (append only).**
  - **Scope:** conversations from `ctx.conversations.list({ quietSince })` after a watermark stored in `ctx.storage`, oldest first, at most `BRAIN_NIGHTLY_MAX_CONVERSATIONS` (default 30) per run.
    - On the first run the backlog within conversation retention is worked through over several nights.
    - A conversation that is resumed and goes quiet again is read again, but only its new entries count.
    - Conversations with almost no user text are skipped without a model call.
  - **The prompt is a filter first:**
    - "No notes" is the expected answer.
    - It records only facts the user stated or confirmed, that will still be true in a month, and that are about the household's world.
    - It never records what is true only inside the conversation, what can be queried live, moods, what Friday said, or anything a page already says.
    - Tool results are left out of the transcript. They are data fetched from elsewhere and may try to steer the model.
  - **Output:** a list of notes (`entity`, `fact`, `type?`), appended exactly like `brain_remember`, as revisions with author `extraction` and the source conversation id. Extraction never rewrites or removes text.
  - **Failures:**
    - A per-conversation failure (`invalid_output`, `blocked`) is recorded and retried on the next 2 runs, then given up with a log line.
    - An `unavailable` model stops the step without advancing the watermark.
- **Step 2: consolidate (the only rewriter).**
  - **When it runs:** only when pages changed since the last successful consolidation.
  - **What it plans:** one call over the whole brain, with actions:
    - `rewrite`: fold `## Notes` into the body, dedupe, newer wins, add `[[links]]` for relationships already stated, optionally rename or re-alias.
    - `create`: a new page, for example to move content off an over-budget profile.
    - `merge`: fold one page into another. The absorbed page is soft-deleted and its names become aliases.
  - **Every action declares the lines it deliberately drops** (for example a superseded fact) with a reason.
  - **The plan applies in one transaction: all or nothing.** It is refused when any action:
    - targets an unknown or stale page, or empties a page;
    - touches the profile's name, or merges the profile;
    - uses a tombstoned name;
    - grows an over-budget profile;
    - **loses a line it didn't declare**, checked mechanically.

    A refused plan is sent back once with the reasons for one corrected attempt. Otherwise nothing changes that night. Doing nothing is a valid plan.
- Shared **page-writing guidance** used by both steps: state each fact once, newer wins, phrase inferences as tendencies, never invent, never treat a device name (`kitchen`) as a person.
- **Changes apply directly.** There is no approval queue. The portal gets a **`Nightly` tab** in `/m/brain`:
  - The recent runs with their summaries.
  - Per run, the changed pages with a diff from before the run to after it, the dropped lines with their reasons, and the source conversations (marked as gone once retention has deleted them).
  - A one-click **revert** per page. Reverting a merge also restores the absorbed page.
- The job can be run on demand with `Run now` on the Jobs page. There is no maintenance tool for the model.
- **Positive-control fixtures:** synthetic transcripts with known facts and known non-facts. Tests run them against a fake LLM for the plumbing, and an opt-in `eval` script runs them against the real model (`FRIDAY_TEXT_MODEL`) through the test host to check prompt quality.

Out of scope: a weekly pattern pass, model tiers or providers other than `ctx.llm`, per-fact confidence, dates and reminders, a graph view, and processing a conversation as soon as it goes quiet (`onQuiet`).

## Capabilities

### New Capabilities
- `brain-maintenance`: the `brain/nightly` job with its extract and consolidate steps, watermark and retry handling, plan validation and all-or-nothing application, the run record, and the portal's `Nightly` review and revert.

### Modified Capabilities
- `brain`: revision ids are guaranteed to increase and never be reused (also after a purge). The nightly pass depends on that for its consolidation trigger, its run's revision range and revert. The `brain` implementation already provides it (`AUTOINCREMENT`); the requirement makes it part of the contract.

## Impact

- **Module**: `modules/brain` gains:
  - the job, prompts and guidance, extraction and plan application;
  - brain migration 2 (`brain__runs`);
  - routes for runs and revert, and the `Nightly` tab in the UI;
  - the fixtures and `scripts/eval.ts`, with `@google/genai` as a dev dependency used only by the script.
- **Depends on** `brain` being merged. It uses `ctx.jobs`, `ctx.conversations`, `ctx.llm`, `ctx.storage` and `ctx.db` as specified.
- **Cost:** at most 30 extraction calls plus 1 or 2 consolidation calls per night, on the `standard` tier. They share the `FRIDAY_LLM_CONCURRENCY` bound, and usage is logged without content. `FRIDAY_TEXT_MODEL` defaults to `gemini-flash-latest`, and the README recommends a stronger model when memory quality matters.
- **Config**: `BRAIN_NIGHTLY_CRON` and `BRAIN_NIGHTLY_MAX_CONVERSATIONS` (manifest config and `.env.example`).
- **Docs**: README (what the nightly pass does, how to review and revert, the eval script).
- **Security**: conversation content goes to the text model, which already happens for chat. Tool results are excluded from the extraction input to limit prompt injection through fetched data. `/security-review` applies.
