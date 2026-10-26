# Design

> Draft from an explore session on 2026-10-26. See proposal.md for the motivation.

## Context

- The profile is a row in `brain__pages` with `id = 'profile'` and `is_profile = 1` (`modules/brain/src/schema.ts`). It has a body and revisions like any page. It is protected: it can't be deleted, renamed or retyped.
- `brain_remember({ entity: "profile" })` appends dated notes to it. Extraction routes "facts about the speaker" and "facts about the household" there (`EXTRACTION_FILTER` in `src/nightly/guidance.ts`).
- Consolidation may rewrite the profile like any page. The `PROFILE` guidance asks it to move entity detail to pages, but only for people, places, projects and organisations, and not for an entity known by name and relation alone. The loss check (`preserved`, `namedPages` in `src/nightly/consolidate.ts`) accepts a removed profile line when the page it names states it.
- `brain_recall` never returns the profile. The prompt context (`src/context.ts`) renders an intro that says memory is background, then the profile body, then an index of 50 recent pages, all under 10000 characters.
- Links exist only as `[[...]]` in bodies. Nothing adds them. The `LINKING` guidance asks the model to link on first mention.
- The system prompts are fixed in `packages/core/src/config.ts`. The user has no way to adjust them.
- Friday has no notion of who is speaking: no user accounts, no speaker identity, one household brain.
- The nightly job can be started by hand (`POST /api/jobs/brain/nightly/run`, trigger `manual`).

## Goals / Non-Goals

**Goals:**
- Pages are where facts live. The summary is derived and can always be rebuilt from them.
- A user-owned place for standing instructions that no tool or conversation can write to.
- Links between the summary and pages, and between pages, that don't depend on the model remembering to add them.
- Choices that don't have to be undone if Friday ever serves more than one person.

**Non-Goals:**
- Several users, speaker identity, private pages (see D11 for the intended direction).
- Separate instructions per channel. The user can scope a line in the text ("In voice: …").
- Rewriting existing pages from "the user's …" to the user's name in one pass. They are reworded as they change.
- New page types. Hobbies, belongings and pets use `other` (a pet may use `other` too; `person` stays for people).

## Decisions

### D1. The profile row stays; it gains instructions and a subject

The profile keeps its id, its name and its revisions. A brain migration adds:
- `instructions` (text) to `brain__pages` and `brain__revisions`. It is only used for the profile, so a profile revision snapshots both parts.
- `subject_id` to `brain__pages`, set on the profile row only, referencing the user's page.

The profile's `body` becomes the summary.

Alternatives:
- **Instructions as a separate special page.** That gives a second protected page and a second set of exceptions in every route.
- **Instructions in `ctx.storage`.** That loses the history and restore the portal already offers for revisions.
- **Subject in `ctx.storage`.** The store couldn't enforce that the subject page isn't deleted, because the reference would sit outside the database.

### D2. Instructions are user-only and saved per field

- Only the pages API writes instructions. They come from the portal and are recorded as a revision with author `user`.
- No tool, extraction or consolidation can write them. This is what makes it safe to frame them as directives (D3): nothing said in a conversation, and no tool result, can become a standing instruction.
- They are capped at `INSTRUCTIONS_MAX` (2000 characters). A longer save is refused with `invalid`.
- The stale check for an instructions save compares the instructions at the base revision with the current ones, not the revision id. The nightly pass regularly writes the summary, and it shouldn't cause a conflict with an instructions edit. Saving based on revision 4 while the summary moved on to revision 5 succeeds when revision 5 has the same instructions.

### D3. The prompt context frames instructions as directives, the summary as background

The brain's context becomes:

```
## The user's instructions                 <- only when set; never cut
Follow these standing preferences of the user ...
<instructions>

## Memory                                  <- the current intro, reworded: the profile summary
### Profile                                   is background; details are on the linked pages
<summary>
### Pages
<index of 50>
<outro: brain_remember>
```

The intro says the instructions are the user's own standing preferences. They don't override how Friday ends conversations or uses tools. The 10000-character bound stays. Index entries are dropped first, then the summary is cut at a line boundary, and the instructions are never cut (D2 bounds them). The context still comes from the brain module's provider, so core doesn't change.

Alternative: a core setting for a custom system prompt. That would be a second place to steer Friday, outside the profile where the user expects it.

### D4. The subject page is the user's page

- The subject is a `person` page. It can't be deleted or purged, and its type is fixed. It can be renamed, and the old name becomes an alias as usual.
- `brain_remember` resolves the entities `profile` and `me` (case-insensitive) to the subject. `profile` stays reserved as a name.
- Extraction's "facts about the speaker" go to the subject, and "facts about the household as a whole" go to the household page. The household page is the existing `Home` page when there is one; the guidance names it from the brain, otherwise a `Home` page is created.
- `brain_recall` returns the subject like any page. Questions about the user now find a page, which they never did while the profile was excluded.
- The profile can no longer be the target of `brain_remember`, of extraction, or of a consolidation plan action.

### D5. The summary is generated in its own step after the plan

After the consolidation plan is applied (or found empty), a **summary step** runs when any live page changed since the last summary, or when the guidance changed.

Its input is:
- the guidance;
- the budget;
- the subject page and the household page in full;
- the other pages, in full up to the same bound the plan uses (subject first, then its link neighbours, then by recency), with an index for the rest;
- the current summary.

The model returns the summary text. Validation refuses it when:
- it is over `BRAIN_PROFILE_TOKEN_BUDGET`;
- a `[[link]]` doesn't resolve to a live page;
- a line isn't **backed**: most of its significant words, other than the names of the pages it names, must occur in the subject page or in the pages it names (`preserved` and `namedPages`, reused).

A refused summary gets one repair round. When that fails too, the old summary stays and the run is `partial`.

A valid summary is written as a profile revision with author `consolidation`, and recorded in the run like any page the run changed, so the Nightly tab shows its diff and can revert it.

The backing check prevents invention, not omission. Omission is acceptable: the summary is a convenience, and every fact is still on a page.

The step runs after a refused plan, because the pages are then as they were and the summary can still follow them. It doesn't run when consolidation found the model unavailable, or when the run was cancelled: an outage waits for the next run, as it does in extraction.

Alternatives:
- **A `summary` action inside the plan.** The plan's validation is about not losing lines. A derived summary loses nothing by dropping a line, so it would need a separate set of rules inside the same validator.
- **A summary rendered by code from page first lines.** That's deterministic, but it can't summarize, and the result reads like an index the prompt already has.

### D6. What gets a page

The guidance changes in four ways:
- **Every person, place, project, organisation, hobby or topic, belonging and pet that the summary names gets a page and a link.** The name-and-relation exemption goes. A stub page ("Dimitri: Raymond's brother.") is fine.
- **Hub pages:** one page per hobby or topic (`Motorcycles`, `RC racing`, `Gaming`). An item gets its own page once it holds facts of its own (`Honda CB900F` with its restoration), linked from the hub.
- **Instruction-like facts:** a fact such as "Prefers to be called Ray" goes on the subject page. The summary may carry it.
- **Pages name the user:** relations to the user are written with the subject page's name ("Raymond's brother"). While the subject is still named `Me`, the guidance says "the user" instead.

### D7. Links are added by code on non-user writes

After a write by `remember`, `extraction` or `consolidation`, including the summary, the store links the first mention in the new body of each live page's name or alias. It skips:
- pages the body already links;
- the page itself and the profile;
- names shorter than 3 characters;
- mentions inside a word, inside an existing link, or inside code.

Matching is case-sensitive, so "at home" stays text and "Home" becomes `[[Home]]`. Longer names are matched first, so "Honda CB900F" wins over "Honda". Writes by `user` and `system` are left as typed. Links are added before the revision is written, so the revision records the linked body.

Alternatives:
- **Prompt-only.** That's what happens today, and it doesn't hold.
- **Refusing unlinked plans.** A cosmetic miss would fail the whole plan, and after the repair round nothing would be written.
- **Implicit links at read time.** That would change what a link is everywhere (backlinks, rendering, purge) and give false positives in every view.

The guidance still asks the model to use exact page names, because code can't link a paraphrased name.

A plan's writes happen one action at a time, so a rewrite listed before a `create` would miss the new page. `applyPlan` therefore passes the names the plan creates to every write it makes (`alsoLink`). A link to a page created later in the same transaction resolves once the transaction commits.

### D8. Portal

- The profile view shows **Instructions**, editable with the stale check from D2, and the **Summary**, rendered read-only with its links, the time and run that generated it, and a `Run nightly now` action that calls the jobs API.
- History and restore on the profile restore the instructions only.
- The subject page is marked as the user's page, with no `Delete`. While it is named `Me`, the portal asks the user to give it their name. `GET pages/:id` carries `isSubject`, so the page view knows this without loading the whole list.
- `PUT pages/profile` accepts `instructions` only. A changed body, name or type is refused with `profile`.

### D9. Budget

`BRAIN_PROFILE_TOKEN_BUDGET` (default 800) becomes the summary's hard target in validation (D5). Instructions don't count against it. The portal keeps showing the summary's size against the budget. "Over budget" can only appear for the migrated body, before the first generation.

### D10. Migration

Brain migration 3, in one transaction:
1. Add the columns from D1.
2. Create the subject page: type `person`, named `Me` (or `Me 2`, `Me 3`, … when that name is taken or tombstoned), with the profile's current body. Write it as a revision with author `system` and the note `moved from the profile`.
3. Set `subject_id`. Leave the profile body as it is, so the prompt doesn't lose the user's details until the first summary is generated.
4. Set empty instructions.

`GUIDANCE_VERSION` goes to 3. The next nightly run then marks the subject page as changed (instead of the profile), splits it into entity pages with the new guidance, and generates the first summary. The user can start that run immediately from the portal.

Rollback: the migration only adds columns and one page. The previous release ignores the new columns and keeps working, with the subject as an ordinary page. Any page change can be reverted per run in the Nightly tab.

### D11. Several users later (direction, not built)

The intended model is **one shared household brain with a profile per user**:
- Pages are shared (the house, the cats, the people).
- Each profile has its own instructions, subject page and summary, written from that user's perspective ("Wife: [[Lisa]]" versus "Husband: [[Raymond]]").
- "Me" resolves to the identified speaker's subject.
- Private pages can be added on top later.

This change keeps that open: the subject is referenced by id, pages name the user instead of saying "the user", and instructions and summary are fields of a profile, not of a page body. Identity (device, voice, portal login) is the prerequisite and its own change.

Rejected for later: a separate brain per user. It duplicates the shared world, and the same person would be a page in one brain and "me" in another.

## Risks / Trade-offs

- **A fact remembered today reaches the summary only after the next nightly run.** → The page and the index have it right away, and `brain_recall` finds it. The run can be started by hand.
- **The summary churns or leaves out something the user expects.** → The summary is only regenerated when pages changed. Each generation is a reviewed, revertible revision. Instructions are the place for anything the user wants in the prompt for certain.
- **Stub pages crowd the 50-entry index.** → The index is ordered by recency, so stubs that never change sink. `brain_recall` still finds them.
- **Auto-linking a common word** (a page named `Home` at the start of a sentence). → Case-sensitive matching, a minimum length, user edits untouched, and every write revertible. In a household brain such a mention usually means the page anyway.
- **Instructions steer every conversation.** → Only the portal writes them (no tool, no extraction). The portal is reachable only by those who can already change Friday's configuration there.
- **The summary step costs one extra model call per run in which pages changed.** → It's skipped when nothing changed.

## Open Questions

- The exact wording of the instructions block's framing and the summary-step prompt. To be tuned against the eval fixtures.
- Whether `INSTRUCTIONS_MAX` = 2000 is the right cap. It's easy to change, and the 10000-character context bound holds either way.
