# Proposal

## Why

After a get-to-know-you chat, the nightly pass folded everything into the profile and created no pages. The guidance says the profile holds "the household's members", facts about "me" go on the profile, and pages are only created "to move detail off an over-budget profile". Under the 800-token budget, consolidation has no reason to split anything out. The profile should be a short summary that Friday always has at hand. The detail about the people, places, projects and organisations in the user's life should be on their own pages, where `brain_recall` finds it and the user can curate it.

## What Changes

- **The profile becomes a summary.** It covers who the user is, who is in the household and their relation to the user (with a `[[link]]`), and standing preferences. Detail about an entity goes on that entity's page, even when the profile is under budget. A fact may be both on the profile, in short form, and on the page.
- **Consolidation sets up entity pages.** When the profile, or a note on it, holds facts about a person, place, project or organisation beyond its name and relation, consolidation creates or extends that entity's page. It shortens the profile line to a summary with a `[[link]]`.
- **The loss check sees the linked page.** A line removed from a page now also counts as preserved when the page that line names (by `[[link]]`, name or alias) already states it. Trimming the profile then doesn't need an action that repeats what the entity page already says.
- **Extraction and `brain_remember` route facts to entities.** A fact about a named other person, place, project or organisation goes on that entity's page, even when said in the first person ("my sister Anouk works at…"). Only facts about the user themselves go on the profile.
- **The prompt context says where detail lives.** The memory instructions say the profile is a summary and that the details are on the linked pages, through `brain_recall`.
- **Existing brains are reconsidered once.** Consolidation has a guidance version. When the stored version is older than the current one, the next run consolidates even if no page changed, and treats the profile as changed. On the homelab, last week's chat then gets split into pages on the next night, or right away with `Run now`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `brain-maintenance`:
  - consolidation keeps the profile a summary backed by entity pages, and runs once when its guidance changes;
  - the loss check also accepts facts already stated on the page a removed line names;
  - extraction puts facts about named other entities on their pages.
- `brain`:
  - `brain_remember`'s description routes facts about named other entities to their pages;
  - the prompt context describes the profile as a summary.

## Impact

- **Code:** `modules/brain/src/`:
  - `nightly/guidance.ts`: the profile, extraction and consolidation guidance;
  - `nightly/consolidate.ts`: the guidance version trigger, and the loss check against named pages;
  - `tools.ts`: `brain_remember`'s description;
  - `context.ts`: the memory instructions.
- **Tests:** `modules/brain/test/`: guidance, consolidate, context, tools. New nightly fixtures cover a profile under budget with entity detail, and a first-person fact about a named relative.
- **Data:** no migration. One new `ctx.storage` key (`consolidate:guidance`). The first run after deploy makes one consolidation model call, even when nothing changed.
- **Docs:** the brain section of `README.md`, if it describes the profile, and the brain part of the `openspec/config.yaml` context.
- **Configuration:** no new environment variables.
- **Overlap:** `add-voice-device-onboarding` also edits the `openspec/config.yaml` context, in a different part. There's no code overlap.
