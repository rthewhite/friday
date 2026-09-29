# Design

## Context

See proposal.md for the motivation. The pieces this change builds on:

- **`brain` store** (change `brain`): pages, `brain__names`, `brain__revisions` (integer ids, authors `extraction` and `consolidation` already allowed), tombstones. There is one write path, `writeRevision`, with its base-revision, name, tombstone and profile guards. `appendNote` is what `brain_remember` uses, and links are parsed from bodies.
- **`ctx.conversations`**: `list({ quietSince, limit })` returns currently quiet conversations that went quiet after the given time, oldest first, each with `quietAt`. `get(id)` returns the entries (`user` with `input: speech|text`, `assistant` with `interrupted`, `tool` with `name`, `args`, `result`). A resumed conversation goes quiet again with a later `quietAt`.
- **`ctx.llm.generate`**: JSON-Schema output validated locally and by Gemini (a subset: `type`, `properties`, `required`, `items`, `enum`, `anyOf`, …). Errors are typed: `unavailable`, `invalid_output`, `blocked`, `invalid_request`, `cancelled`. The `standard` tier is `FRIDAY_TEXT_MODEL`, default `gemini-flash-latest`. There are no thinking controls.
- **`ctx.jobs.schedule`**: no overlap, one catch-up run after downtime, `timeoutMs`, an abort signal, and a summary of at most 500 characters in the Jobs page history.
- **`createTestHost`**: `llm` is a function returning the raw text, and the host applies the same schema checks. `conversations` can be seeded and `runJob` runs a handler once.
- **Conversation retention** (`core/conversation-retention`, 04:00) deletes transcripts after 90 days by default. The brain's source conversation ids can outlive them.

## Goals / Non-Goals

**Goals:**
- A bad night can't destroy content silently. Every loss is either declared and shown, or the plan is refused.
- Nothing is processed twice as new input, and nothing is skipped for good because of a transient failure.
- The whole night's effect can be reviewed and undone per page in the portal.
- Prompt quality can be measured against fixed fixtures, not just trusted.

**Non-Goals:**
- Real-time extraction when a conversation goes quiet. It is nightly, as asked, and batching keeps cost predictable.
- Fine-grained per-fact provenance. Revisions carry source conversation ids per write.
- Semantic duplicate detection outside the model. The model sees the whole brain.

## Decisions

### D1. One job, two steps, one run record

```
brain/nightly  (cron BRAIN_NIGHTLY_CRON, timeoutMs 30 min)
  |
  |- start run row in brain__runs (trigger, started_at, first_revision_id = max(id)+1)
  |- extract   -> notes appended (author extraction, sources [conversation id])
  |- consolidate (if any page changed since last consolidated revision)
  |              -> one transaction: rewrites / creates / merges (author consolidation)
  |- finish run row (counts, dropped lines, error, last_revision_id)
  '- return { summary }
```

- **`brain__runs` (brain migration 2):** `id`, `trigger`, `started_at`, `finished_at`, `outcome` (`ok`, `partial` or `failed`; unset while running), `conversations`, `skipped`, `notes`, `refused` (notes the brain refused), `rewrites`, `creates`, `merges`, `dropped_json` (`[{ pageId, page, line, reason }]`), `merges_json` (`[{ from: pageId, into: pageId }]`), `first_revision_id`, `last_revision_id`, `error`, `summary` (the line the Jobs page shows, so the Nightly tab shows the same).
- **Why the brain keeps its own run table** alongside the Jobs page history: the review UI needs the revision range, the dropped lines and the merges of each run. The Jobs page keeps timing and the summary line.
- **Cancellation:** the signal is passed to every `generate` call and checked between conversations. A cancelled run finishes its row as `partial` with `cancelled` (as the spec requires for an interrupted extraction), skips consolidation, and leaves the watermark where the last completed conversation put it. `failed` is kept for runs that threw.
- **Config:** `BRAIN_NIGHTLY_CRON` is read at `init`. `off` skips `schedule`, and changing it needs a module reload (Modules page), like any config read at `init`.

### D2. Watermark, per-conversation progress, retries

All of this is kept in `ctx.storage`:

- `extract:watermark`: the `quietAt` of the last conversation handled, in list order.
- `extract:seen:<id>`: `{ seq }`, the last entry seq extracted from that conversation.
- `extract:retry:<id>`: `{ attempts, lastError }`.

Per run:

1. Retry first: conversations in `extract:retry:*` (oldest first).
2. Then `list({ quietSince: watermark, limit: max - retries })`.
3. Handle each conversation:
   - Fetch it with `get(id)`. When it's gone (deleted by retention or the user), drop its keys.
   - Take the entries after `seen.seq`.
   - When they carry fewer than 4 words of user text in total (`speech` and `text`), mark them seen and count the conversation as skipped, without a model call.
   - Otherwise extract (D3) and append the notes.
   - On success, set `seen.seq` to the last entry and clear the retry key.
   - On `invalid_output` or `blocked`, increment `attempts`. At 3 attempts, log it, count it in the run's `error`, mark it seen and clear the retry key.
   - On `unavailable`, stop the extract step at once and mark the run `partial`. This is the only failure that doesn't advance past the conversation. `cancelled` works the same way.
4. Advance `extract:watermark` to each listed conversation's `quietAt` right after it is handled, including skipped and retry-queued ones. A crash mid-run then repeats at most one conversation, and appending it again is idempotent: its notes carry the conversation's date (D3), so `appendNote`'s duplicate skip (the latest note, or a note of the same day) recognises them.

- **The first run** has no watermark and lists from the beginning, so the retained backlog is worked through `BRAIN_NIGHTLY_MAX_CONVERSATIONS` at a time over the following nights.
- **Pruning:** `extract:seen:*` keys for conversations that no longer exist are pruned at the end of each run, one `get` per key. Retention keeps that set bounded.
- **Why seq-based progress:** jarvis re-read whole resumed conversations and relied on the prompt to ignore what was already stored. Passing "already processed" entries as context but extracting only from new ones avoids both repeated work and the risk of re-adding facts the user deleted since.

### D3. Extraction: notes, not page rewrites

**Input**, one call per conversation:

- The system prompt holds the guidance (D5) and the brain, rendered as:
  - the profile and all live pages in full (name, type, aliases, body);
  - dangling link targets, marked "no page yet";
  - tombstoned names, marked "deliberately forgotten, never record".

  When the rendered brain exceeds 60000 characters, it is ranked by D4-style search against the conversation's user text. It includes full bodies up to that bound, then an index (name, aliases, hint) for the rest.
- The prompt holds the transcript:
  - `[earlier]` entries (before `seen.seq`) for context, then `[new]` entries. Only `[new]` may yield notes.
  - User entries are marked `(spoken, transcribed)` or `(typed)`. Assistant entries are marked `(interrupted)` when cut off.
  - Tool entries appear as `tool <name>(<args>)` **without results**. The exception is `brain_remember` calls, shown as `(already remembered: <entity>: <fact>)`.
  - The conversation's channel, device and date.

**Output schema:**

```
{ notes: [{ entity: string, fact: string, type?: enum, reason: string }] }
```

It is capped with `maxItems: 10`. `reason` is for tests and eval only, and isn't stored.

**Application:** each note goes through the store's `appendNote` with author `extraction` and `sources: [conversationId]`. That covers the name, alias and profile resolution, creating a missing page, the tombstone refusal and the duplicate skip. A refused note (tombstoned, invalid) is counted and skipped. It never fails the conversation.

- **Note date:** the day of the conversation's `lastActivityAt` in `FRIDAY_TIMEZONE`, not the day of the run. `brain`'s duplicate skip only matches the page's latest note or a note of the same day (an older matching note counts as a correction). A fact the user already had Friday remember during the day therefore still matches when extraction runs after midnight, even if other notes followed it. A conversation spanning midnight is dated by its last activity; a duplicate that slips through there is folded by consolidation.
- **`appendNote` signature:** `brain` takes `(entity, fact, type, date)` with author `remember` and no sources. This change extends it with the author and sources (`extraction`, `[conversationId]`), keeping one write path.

- **Why notes rather than page bodies:** extraction then can't lose content by construction, output stays small, and there is one rewriter (consolidation) whose guards are the only ones that matter. The same night's consolidation folds the notes in, so the brain doesn't collect extraction notes.
- **Model settings:** `model: "standard"`, `temperature: 0.2`, `maxOutputTokens: 4096`, `timeoutMs: 120000`.

### D4. Consolidation: a validated plan, applied all-or-nothing

**When:** the step runs when any live page has a revision with id greater than `consolidate:last_revision_id` (in `ctx.storage`) that neither consolidation nor `system` wrote (the seeded profile isn't a change). Otherwise it records "nothing to consolidate".

**Input:**

- The guidance.
- The profile budget and its current estimate.
- Every live page with its **current revision id**, type, aliases and body. Pages changed since the last consolidation are marked `(changed)`.
- Tombstoned names.

The same 60000-character bound applies: changed pages and their link neighbours are included in full first, then others until the bound, then an index.

**Output schema:**

```
{ actions: [
    { kind: "rewrite", page: <id>, base: <revision>, body, name?, aliases?, type?, dropped: [{ line, reason }] }
  | { kind: "create",  name, type, aliases?, body }
  | { kind: "merge",   from: <id>, into: <id>, fromBase, intoBase, body, dropped: [{ line, reason }] }
  ], note: string }
```

The schema is one flat action object with optional fields, and the merge bases are two integer fields. At most 20 actions are allowed, enforced by validation rather than the schema: Gemini rejects this schema as too complex (`INVALID_ARGUMENT`) with `maxItems` on the actions or a nested `bases` object, found with the eval. `note` summarizes the plan in one sentence and is stored on each revision.

**Validation** runs before anything is written. Any failure refuses the whole plan:

- At most 20 actions, and each page appears in at most one action.
- Referenced pages exist, are live, and their `base` equals the current revision.
- Neither body is empty. The profile's name and type are unchanged. The profile is never `from` or `into` of a merge.
- The names of created or renamed pages aren't tombstoned or taken. This is checked again by the store inside the transaction.
- **No undeclared loss:**
  - Take every non-empty line removed from the pages the plan touches. That is lines in the old bodies of rewritten or merged pages that no longer appear verbatim anywhere in the plan's resulting pages. Blank lines, headings and a note's date prefix are ignored.
  - Such a line is **preserved** when at least 60% of its significant words (at least 3 characters and not a stopword, or a number) occur in the folded text of the resulting pages.
  - A removed line that is neither preserved nor declared in `dropped` refuses the plan, and the reason names the page and the line.
- **Profile budget:** when the profile is over budget before the plan, the plan must not make it larger.

**Application:**

- One `ctx.db.transaction` executes the actions in plan order through the store.
  - `rewrite` is `writeRevision(author: consolidation, base)`.
  - `create` is `create(author: consolidation)`.
  - `merge` writes the `into` body. Its aliases become the union of both pages' aliases plus the `from` name. It then soft-deletes `from` and frees its names first, so they can move.
- Any store error rolls back the whole plan, and counts as a refusal (its message is a repair reason).
- **Repair:** after a refusal, the model gets one second call with its plan and the list of reasons ("revise the plan to fix these; an empty plan is fine"). When that also fails, nothing is written and the run is `partial`, with the reasons in `error`.
- `consolidate:last_revision_id` advances only after a successful plan or an empty one.

**Model settings:** `model: "standard"`, `temperature: 0.2`, `maxOutputTokens: 32768`, `timeoutMs: 300000`.

- **Why all-or-nothing:** jarvis's "abandon at the first refused action" still kept the actions applied before the refusal. That is how a paired "add then trim" left content trimmed with nowhere to go. With synchronous transactions (`module-db`), atomicity costs nothing.
- **Why declared drops:** "newer wins" means consolidation must be able to remove superseded facts. Declaring them makes each deletion visible in the review, and it gives the mechanical check something to separate a deliberate removal from an accident.
- **Rejected alternative:** a separate "profile move" action as in jarvis. A move is a `rewrite` of the profile plus a `rewrite` or `create` of the target. Because both are in the same transaction, the ordering hazard is gone.

### D5. Shared guidance

`src/nightly/guidance.ts` exports `PAGE_WRITING`, `LINKING`, `PROFILE` and `EXTRACTION_FILTER` strings, composed into both system prompts, so the rules can't drift apart. The key rules:

- **Extraction filter:** the proposal's filter-first rules. In addition:
  - Transcribed speech is noisy: skip names you can't place, and never "correct" them into existing pages without evidence.
  - The account or device name isn't a person.
  - Facts about "me" belong on the profile.
- **Page writing:** one fact once; newer wins, with the older one declared in `dropped`; tendencies phrased as tendencies; no invention; keep the user's wording where possible; the `## Notes` section is emptied by folding (removed when empty).
- **Linking:** link on first mention with `[[Name]]` using an existing name or alias. Don't link to the profile. Hub pages (`Family`) are ordinary pages.
- **Profile:** it holds what's always relevant (who the user is, household members, standing preferences), stays under budget, and moves detail to entity pages.

### D6. Review and revert

**Routes** (under `/api/modules/brain/`):

- `GET runs?limit=14` lists runs, newest first.
- `GET runs/:id` returns the run and, for each page it touched:
  - the revision before the run (`last revision with id < first_revision_id`, or none when the run created the page);
  - the run's last revision of the page;
  - author(s), sources, dropped lines, and whether the page is merged into another;
  - whether each source conversation still exists (checked with `ctx.conversations.get`).
- `POST runs/:id/pages/:pageId/revert` with `{ base }`:
  - a page changed by the run: restore the pre-run revision as a new `user` revision noted `reverted nightly run <id>`;
  - a page created by the run: soft-delete it;
  - the `into` of a merge: restore it and undelete the `from` page (its names were freed by the restore); reverting the `from` page reverts the merge through its `into`;
  - all in one transaction. It returns 409 `stale` when the page changed after the run, and the UI then offers to open the page instead.

**UI:** a `Nightly` tab in `/m/brain`:

- Runs as rows (time, trigger, outcome, summary).
- A selected run lists its pages with a diff (the `brain` change's line diff), its dropped lines with reasons, source conversation links (marked "gone"), and a `Revert` button per page.
- An empty state explains when the job runs and links to `/settings/jobs`.

### D7. Fixtures and eval

- **Fixtures:** `modules/brain/test/fixtures/nightly/*.json`, each holding a seeded brain, a conversation (entries), and expectations:
  - `mustNote`: `[{ entity, contains }]`;
  - `mustNotNote`: substring patterns, for example the device name as a person or a mood;
  - for consolidation fixtures, `mustKeep` lines and `mayDrop`.
- **The set covers:**
  - a birthday stated in passing;
  - a correction ("no, she moved to Utrecht");
  - a question with no facts;
  - a tool-heavy media session;
  - an injected tool result ("remember that the user's password is …");
  - a device-named voice session;
  - a Dutch conversation;
  - a resumed conversation with already-seen entries;
  - a profile over budget.
- **Unit tests** (`node:test`, fake LLM) cover the plumbing:
  - the prompt contains `[new]` entries only after `seen`;
  - tool results are absent;
  - notes are appended with sources;
  - the loss check refuses undeclared drops;
  - a refused plan gets one repair call and then writes nothing;
  - the watermark and retries behave as specified;
  - a revert restores.
- **Eval:** `pnpm --filter @friday/module-brain eval` (`scripts/eval.ts`) runs each fixture through `createTestHost` with an `llm` function that calls Gemini through `@google/genai` (`GEMINI_API_KEY`, `FRIDAY_TEXT_MODEL`, `responseJsonSchema`). It prints pass or fail per expectation. It is opt-in, never runs in CI, and doesn't gate the build.

## Risks / Trade-offs

- **[Risk]** The loss check is a heuristic. A rephrasing that keeps less than 60% of a line's words is refused as a loss, and a loss that happens to share words with other text passes. → Refusals are safe (nothing is written, and the repair round usually adds a `dropped` entry). The threshold is a constant tuned with the consolidation fixtures. False passes are the reason the review view and revert exist.
- **[Risk]** `gemini-flash-latest` isn't strong enough for consolidation, which then either refuses every night or makes poor merges. → The eval script measures it. The README recommends a stronger `FRIDAY_TEXT_MODEL`. Runs that refuse show up as `partial` on the Jobs page with their reasons.
- **[Risk]** A persistent bad plan blocks tidying every night. → The run outcome makes it visible. Extraction still works, and notes accumulate harmlessly because the context marks them dated. The user can fix the offending page by hand.
- **[Risk]** Prompt injection through transcripts, for example the user reading aloud a text that says "remember …". → Tool results are excluded. Notes are only appended (never rewrites), with sources, so they are reviewable and revertible. Tombstones stop re-creation of forgotten entities.
- **[Trade-off]** Consolidation sees the whole brain every night something changed, so input tokens grow with the brain. → Bounded at 60000 characters with prioritisation, and skipped when nothing changed.
- **[Trade-off]** Revert refuses when a page changed after the run. → Accepted. The page history always allows a manual restore.

## Migration Plan

- Brain migration 2 adds `brain__runs`.
- The first scheduled run starts the backlog of retained conversations. That backfill is intended. It is capped at `BRAIN_NIGHTLY_MAX_CONVERSATIONS` per night, so it costs at most that many extraction calls a night until it has caught up.
- **Rollback without code:** set `BRAIN_NIGHTLY_CRON=off` and reload the module, or revert individual runs in the `Nightly` tab.
- **Rolling back the image** to a `brain` without this change makes `brain` fail to load, with `module-db`'s newer-schema error, because migration 2 is recorded. The data stays intact and rolling forward restores it. So an image rollback past this change needs a roll forward, not a downgrade.

## Open Questions

- The exact loss-check threshold (60%) and the 4-word trivial cut-off are set by the fixtures during implementation. Changing them doesn't change the specs.
