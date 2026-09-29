# Tasks

Prerequisite: `module-db` is merged into `main` (`ctx.db`, `migrations`, `ctx.prompt`, test host `db` / `promptContext`).

## 1. Package and schema

- [x] 1.1 Scaffold `modules/brain` (`@friday/module-brain`) following `modules/media`:
  - `package.json` with `friday.ui` and a `markdown-it` dev dependency, a `tsconfig.json` excluding `src/ui`;
  - a manifest (`id: "brain"`, `ui: true`, config `BRAIN_PROFILE_TOKEN_BUDGET` and `FRIDAY_TIMEZONE`);
  - an entry in `packages/core/src/modules.ts` and a dependency in `packages/portal/package.json`.

  Verify `pnpm install`, `pnpm --filter @friday/module-brain typecheck` and `pnpm --filter @friday/portal typecheck` succeed
- [x] 1.2 Write migration 1 (`brain__pages`, `brain__names`, `brain__revisions` with its indexes, `brain__tombstones`), seeding the profile and its `system` revision. Verify with `modules/brain/test/schema.test.ts` via `createTestHost`: after start there is exactly one page (the empty profile) with one revision, and a second host start on the same seeded data runs no migration

## 2. Store

- [x] 2.1 Implement name keys (NFC, trim, collapse whitespace, lower-case), field validation (name and alias rules, 20 aliases, 20000-character body, type enum, `profile` reserved) and typed store errors (`invalid`, `stale`, `name_taken`, `tombstoned`, `not_found`, `profile`). Verify with unit tests in `test/store.test.ts` for each rule
- [x] 2.2 Implement `BrainStore` with the single `writeRevision` path inside `ctx.db.transaction`:
  - `create`, `save` (base revision check; rename keeps the old name as an alias unless removed), `get`, `list`, `revisions`, `revision`;
  - the tombstone guard for non-`user` authors, and a `user` create or rename lifting it;
  - `brain__names` replaced per write.

  Verify with `store.test.ts` cases:
  - create;
  - `name_taken` on an alias colliding with a name;
  - `stale` returning the current page;
  - a rename adding the alias;
  - profile rename/retype refused;
  - a non-user write with a tombstoned name refused, and a user create lifting it;
  - a failing write leaving no partial rows.
- [x] 2.3 Implement `restore` (new `user` revision noting the restored id), `softDelete` (not the profile, frees names), `undelete` (`name_taken` naming the collisions) and `purge`:
  - soft-deleted pages only, with the exact-name confirmation;
  - tombstones for the name and aliases not owned by live pages;
  - inbound links unlinked as `user` revisions with a note;
  - page and revisions deleted, and the rewritten page names returned.

  Verify with `store.test.ts` cases mirroring the spec scenarios (restore keeps history, delete/undelete, undelete after reuse, purge rewriting `[[Old job]]` in the profile, purge of a live page refused, confirm mismatch refused)

## 3. Links and search

- [ ] 3.1 Implement `src/links.ts` (no Node or DB imports, shared with the UI): parse `[[Name]]` targets, context lines cut to 160 characters, and unlink (rewrite `[[Name]]` to `Name` for a set of name keys). Add resolved/dangling outgoing links and backlinks in the store. Verify with `test/links.test.ts`: backlink with its line, resolution through an alias, dangling target, links in deleted pages ignored, and unlink leaving other links intact
- [ ] 3.2 Implement search (fold case and accents, split on non-letter/digit, drop words of 2 characters or fewer and the English/Dutch stopword list, at most 8 words, count distinct words in name, aliases and body with name/alias hits weighted double, ties by `updated_at`, profile and deleted pages excluded). Verify with `test/search.test.ts`: wifi-password-on-`Home`, "cafe" finding "café", a Dutch stopword query, name hit outranking a body mention, and a 9-word query using 8

## 4. Tools

- [ ] 4.1 Implement `brain_remember`:
  - clean the fact, resolving `profile`, names and aliases;
  - create the page when unknown, or refuse `tombstoned` with the "deliberately forgotten" message;
  - skip a fact already on the page (`already_known`);
  - append `- <date>: <fact>` under `## Notes` (heading added when missing), dated in `FRIDAY_TIMEZONE`;
  - write a `remember` revision, returning `{ stored, page, created }` or `{ stored: false, reason }`.

  Verify with `test/tools.test.ts` via `host.call`: new person page (date fixed with an injected clock), alias resolving, existing text untouched with notes appended in order, repeated fact, profile fact, tombstoned entity, empty or over-500-character fact refused
- [ ] 4.2 Implement `brain_recall` (exact entity match first, then the top 3 others, `found_by`, pages with name/type/aliases/body/updatedAt, up to 10 connections with outgoing links first then backlinks, `{ found: false, pages }` on a miss, profile never returned) and the tool descriptions from design D3/D4. Verify with `tools.test.ts`: name plus search, topic search, nothing found listing names, profile excluded, and a test asserting the module's tools are exactly `brain_remember` and `brain_recall` in both channels (`host.toolsIn`)

## 5. Prompt context

- [ ] 5.1 Implement the context provider (D6):
  - the instructions (always present), the profile, and an index of up to 50 pages by recency with hints and "…and N more";
  - the 10000-character bound, dropping index entries first and then cutting the profile at a line with a marker;
  - the profile token estimate (`ceil(chars / 4)`) against `BRAIN_PROFILE_TOKEN_BUDGET`.

  Verify with `test/context.test.ts` via `host.promptContext("voice")` and `("chat")`: profile text and an index line present, empty brain still mentioning `brain_remember`, 80 pages listing 50 and "30 more", an oversized profile staying under 10000 characters, and deleted pages not listed

## 6. HTTP routes

- [ ] 6.1 Register the D7 routes with `ctx.http.route`, mapping store errors to `{ error, code }` with 400/404/409, and returning the profile budget and deleted pages in `GET pages`. Verify with `test/routes.test.ts` via `host.request`:
  - list shape;
  - get with revisions, links and backlinks;
  - create 201 and `name_taken` 409;
  - save 200 and `stale` 409 carrying the current page;
  - restore;
  - delete 204 and profile delete 400;
  - undelete 409;
  - purge with a wrong confirmation (400), purge of a live page (409), and a successful purge listing unlinked pages.

## 7. Portal UI

- [ ] 7.1 Add a `brain` icon to `@friday/portal-ui` `Icon.vue`. Verify it renders in `packages/portal-ui/test/components.test.ts`
- [ ] 7.2 Implement the UI helpers in plain `.ts`:
  - the `markdown-it` instance (`html: false`, safe links) with the `[[Name]]` inline rule producing internal and dangling link markup;
  - line diff, hint extraction and token display.

  Verify with `test/ui-lib.test.ts`: a wikilink renders as an internal link with the page id, a dangling link renders marked, `<img src=x onerror=…>` renders as text, and a line diff marks added and removed lines
- [ ] 7.3 Build the list page (`src/ui/BrainPage.vue`) and `defineModuleUi({ id: "brain", nav: { label: "Brain", icon: "brain", order: 20 } })`:
  - the profile pinned with its budget meter and over-budget badge;
  - the `DataTable` with client-side search;
  - a `New page` drawer;
  - "Recently deleted" with `Restore` and a typed-name permanent delete showing the unlinked pages.

  Verify `pnpm --filter @friday/portal build` passes, then in `pnpm dev` (free ports) create two pages, search, delete, restore and purge one
- [ ] 7.4 Build the page view (`src/ui/PageView.vue`, route `p/:id`):
  - rendered body with click-delegated navigation, and dangling links opening a pre-filled `New page`;
  - backlinks;
  - edit mode (name and type fixed for the profile) with the stale-save prompt (`Discard my edits` / `Overwrite`);
  - delete with the "can be restored later" confirmation, absent on the profile;
  - a `History` tab with author badges, source links to `/conversations?id=`, the diff against the previous revision, and `Restore this version`.

  Verify in `pnpm dev`:
  - follow a link and create a page from a dangling link;
  - trigger a stale save by calling `brain_remember` from the Chat page while editing;
  - restore an older revision.

## 8. Docs and integration

- [ ] 8.1 Document the brain in the README (what Friday remembers, the notes and nightly-tidying model, profile budget, where to curate and how purge works) and `BRAIN_PROFILE_TOKEN_BUDGET` in `.env.example`. Add the module to the `openspec/config.yaml` context. Verify the README's example `curl` against `GET /api/modules/brain/pages` works on a local core
- [ ] 8.2 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree and verify all pass
- [ ] 8.3 End-to-end on a local core with a real `GEMINI_API_KEY`:
  - in Chat, ask Friday to remember two facts about a named person and one about yourself;
  - verify both pages and the notes in `/m/brain`;
  - start a new chat thread and ask about that person, checking the answer uses the memory (via the context index and a `brain_recall` tool entry on the Conversations page);
  - repeat one question by voice on the Talk page.
