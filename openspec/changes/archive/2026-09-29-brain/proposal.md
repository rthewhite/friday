# Proposal

## Why

Friday forgets everything between conversations. Now that conversations are stored, and modules can have their own tables and add to the prompt (`module-db`), Friday can get a long-term memory: a household "brain" of small pages about the people, places and projects in the user's life. Friday reads from it in every conversation and writes to it when asked to remember something. You can see, correct and delete what it holds in the portal.

This rebuilds the jarvis brain for Friday. It keeps what worked there: markdown pages per entity, full revisions, a budgeted profile, `[[links]]`, and forgetting through tombstones. It drops what Friday doesn't need, such as per-user scoping and a separate memory service.

## What Changes

- New in-process module **`modules/brain`** (id `brain`, package `@friday/module-brain`) with its own tables via `ctx.db` (`brain__*`):
  - **pages**: name, type (`person`, `place`, `project`, `other`), aliases, markdown body, soft-delete time. There is exactly one **profile** page, about the user and the household, which can't be deleted, renamed or retyped.
  - **names**: every live page's name and aliases, unique case-insensitively, so collisions are refused by the database.
  - **revisions**: a full snapshot for every write, with author (`system`, `user`, `remember`, and `extraction` and `consolidation` reserved for `brain-nightly`), base revision, source conversation ids and a note. The author is validated in code, not with a `CHECK` constraint.
  - **tombstones** for purged names.
- **One brain per household.** Friday has no user identity, so pages aren't scoped per person.
- **Tool `brain_remember(entity, fact, type?)`**, append only:
  - It adds a dated line (`- 2026-09-29: …`) to a `## Notes` section of the entity's page and records a revision. It creates the page if the name or alias doesn't exist, and `entity: "profile"` targets the profile.
  - It never rewrites existing content, and a fact already on the page word for word isn't added again.
  - Tombstoned names are refused.
  - It is one round trip, so voice conversations don't stall. The nightly pass (`brain-nightly`) folds the notes into the page.
  - Tool calls don't carry a conversation id, so `remember` revisions have no source conversations.
- **Tool `brain_recall(query, entity?)`**:
  - An exact name or alias match comes first, merged with the top 3 substring-search hits across names, aliases and bodies. Search is accent-insensitive and ignores English and Dutch stopwords. There are no embeddings and no FTS.
  - It returns full page bodies plus up to 10 link connections (names and the linking line, not the linked pages' bodies).
  - When nothing matches, it says so and lists the available page names.
- **No delete or rewrite tool.** Friday can't delete memories. Deleting happens in the portal.
- **Prompt context** through `ctx.prompt.addContext`, the same for voice and chat:
  - The profile verbatim.
  - An index of up to 50 recently updated pages (name, type, aliases, first-line hint), with "…and N more" beyond that.
  - Short instructions on when to use `brain_recall` and `brain_remember`.
- **Profile budget** (`BRAIN_PROFILE_TOKEN_BUDGET`, default 800, estimated as characters / 4) is a **soft** target:
  - `brain_remember` on the profile is always accepted, so an explicit "remember" is never lost or evicted.
  - The portal shows usage and flags an over-budget profile, and `brain-nightly` brings it back under.
  - The brain keeps its context under the platform's per-module cap by shortening the index first.
- **Links**: `[[Name]]` in page bodies, resolved through names and aliases. Backlinks and dangling targets are computed from the bodies and never stored. Renaming a page keeps the old name as an alias.
- **Portal UI at `/m/brain`** ("Brain" in the Modules nav):
  - A page list with search, the profile pinned on top with its budget, and create.
  - A page view that renders the markdown without raw HTML, with clickable links (dangling links offer to create the page) and backlinks.
  - A plain editor that detects stale saves.
  - Revision history with a line diff and restore (written as a new revision).
  - Soft delete, undelete, and "Recently deleted".
  - Purge on soft-deleted pages, confirmed by typing the name. Purge tombstones the names, unlinks inbound `[[links]]` as prose, and deletes the revisions.
- **HTTP routes** under `/api/modules/brain/` for pages, revisions, restore, delete, undelete and purge.

Out of scope, and left to `brain-nightly` or later: extracting facts from conversations, consolidation and merging, a pattern pass, a graph view, dates and reminders, and importing jarvis data.

## Capabilities

### New Capabilities
- `brain`: the brain store (pages, names, revisions, tombstones, profile budget, links), the `brain_remember` and `brain_recall` tools, the prompt context it contributes, the brain HTTP routes, and the `/m/brain` portal UI.

### Modified Capabilities
<!-- None: the brain builds on module-db's ctx.db and ctx.prompt without changing their requirements. -->

## Impact

- **New package**: `modules/brain` with the module, migrations, store, links and search, tools, context, routes and tests, plus a `friday.ui` Vue UI built from `@friday/portal-ui` with `markdown-it` for rendering.
  - Listed in `packages/core/src/modules.ts`.
  - A dependency of `packages/portal` (the UI generator requires it).
- **Portal UI kit**: a `brain` icon in `@friday/portal-ui`'s `Icon.vue`.
- **Depends on** `module-db` being merged, for `ctx.db`, `migrations` and `ctx.prompt`.
- **Tool count**: +2.
- **Config**: `BRAIN_PROFILE_TOKEN_BUDGET` (manifest config and `.env.example`). The dates on notes use `FRIDAY_TIMEZONE`.
- **Docs**: README (what Friday remembers, where to curate it) and the `openspec/config.yaml` context.
- **Privacy**: memory content is stored in plaintext in `friday.db` next to the conversations. Purge is the only permanent removal. Transcripts are governed by conversation retention, not by the brain.
- **Security**: new write routes that are covered by the existing cross-origin write refusal. Page bodies may later be written by a model from conversation content, so the UI renders them without raw HTML. `/security-review` applies.
