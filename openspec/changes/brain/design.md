# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- **Dependency:** `module-db` gives the module synchronous `ctx.db` with `transaction(fn)`, migrations run before `init`, tables prefixed `brain__`, and `ctx.prompt.addContext(({ channel }) => string)`, rendered when a voice session opens and when a chat turn starts.
- **Tools:** a handler receives only its arguments (`packages/sdk/src/tool.ts`). There is no conversation id or channel, so a tool can't attribute a write to a conversation.
- **Module UIs:** declared with `defineModuleUi({ id, nav, routes })`. Routes are relative to `/m/<id>`, and sub-routes are allowed (`packages/portal-ui/src/module-ui.ts`). UIs call their module's routes at `/api/modules/<id>/…`. Cross-origin writes to `/api` are already refused by core (`app.ts`).
- **Markdown:** the portal renders model text with `markdown-it` (`html: false`, safe links) in `packages/portal/src/lib/markdown.ts`. It is not exported from `@friday/portal-ui`.
- **What jarvis learned** that this design keeps:
  - Pages per entity rather than fact rows. Rows piled up duplicates that nothing could clean.
  - Full-snapshot revisions as the safety net.
  - Name lookup merged with search. Search only on a miss hid facts filed under the wrong name.
  - Links computed from bodies, never stored. A links table drifts.
  - Tombstones on purge, so extraction doesn't bring a forgotten entity back.
  - Guards in the store, not only in prompts.

## Goals / Non-Goals

**Goals:**
- A `brain_remember` call is a single short transaction that never loses or rewrites existing content.
- A `brain_recall` result is useful from the first word the model tries, whether that is a name, an alias or a topic.
- The store enforces the invariants that `brain-nightly` will rely on: unique names, the profile always present, tombstones respected, every write recorded as a revision.
- The portal is the only place memories are deleted.

**Non-Goals:**
- Fast search over thousands of pages. A household brain is tens to a few hundred small pages, and a full scan is fine.
- Real-time collaboration in the editor. Optimistic concurrency with a conflict prompt is enough.
- Rich editing (WYSIWYG, autocomplete for `[[links]]`).

## Decisions

### D1. Schema (migration 1)

```
brain__pages      id TEXT PK, name TEXT, type TEXT, aliases_json TEXT, body TEXT,
                  is_profile INTEGER, revision_id INTEGER, created_at, updated_at, deleted_at
brain__names      key TEXT PK, page_id TEXT REFERENCES brain__pages ON DELETE CASCADE, kind ('name'|'alias')
brain__revisions  id INTEGER PK, page_id TEXT REFERENCES brain__pages ON DELETE CASCADE,
                  author TEXT, base_revision_id INTEGER, name, type, aliases_json, body,
                  sources_json TEXT, note TEXT, created_at
                  INDEX (page_id, id DESC), INDEX (created_at)
brain__tombstones key TEXT PK, name TEXT, purged_at
```

- **Name keys:** `key` is the name normalized for comparison: NFC, trimmed, internal whitespace collapsed, lower-cased.
- **Why `brain__names`:** uniqueness across names and aliases of live pages is enforced by the primary key. A collision fails inside the write transaction, not in a code-level check that could race. Soft delete removes the page's rows from `brain__names`, so the name becomes free. Undelete re-inserts them and is refused on a collision.
- **Revisions:** `revision_id` on the page points at the newest revision. Integer revision ids give a total order, which `brain-nightly` uses to list "since the last run", and they avoid `AUTOINCREMENT`.
- **Profile:** the migration seeds the profile (name `Profile`, type `other`, empty body) and its first revision with author `system`. Every page therefore has at least one revision, and the "exactly one profile" invariant holds from the first start.
- **Author values:** `system`, `user`, `remember`, `extraction`, `consolidation`, validated in code. Adding one later needs no table rebuild (jarvis needed one for its `CHECK` constraint).

### D2. Store API: all writes go through one function

A `BrainStore` class over `ctx.db`. Every mutation (`create`, `save`, `appendNote`, `restore`, `softDelete`, `undelete`, `purge`) runs inside one `ctx.db.transaction` and ends in a single `writeRevision(page, author, fields, { base, sources, note })`. That function:

- **Checks the base revision.** When a base is given and it isn't current, it throws `StaleRevision`, carrying the current page.
- **Validates the fields.**
  - Names and aliases: 1 to 80 characters, no newline, no `[[` or `]]`, and not `profile` for a non-profile page.
  - At most 20 aliases, deduplicated, not equal to the name.
  - Body at most 20000 characters.
  - Type from the enum.
  - The profile's name and type can't change.
- **Refuses tombstoned names** for every author except `user`. A `user` write lifts the tombstone, because the user is explicitly recreating it.
- **Replaces the page's `brain__names` rows** and inserts the revision.

Errors are typed (`invalid`, `stale`, `name_taken`, `tombstoned`, `not_found`, `profile`, `not_deleted`), and routes and tools map them to responses. `brain-nightly` will add its authors on this same path, so its guards come from here too.

### D3. `brain_remember` appends to a `## Notes` section

The flow of `appendNote(entity, fact, type)`:

1. **Clean the fact:** collapse whitespace and newlines into one line, trim, and reject it when empty or longer than 500 characters.
2. **Resolve the entity:** `profile` (case-insensitive) means the profile. Otherwise match the name key against `brain__names`. With no match, create a page (type from the argument, default `other`). That creation is refused when the name is tombstoned.
3. **Skip duplicates:** when the page body already contains the cleaned fact (case-insensitive substring), nothing is written and the tool returns `already_known`. This is cheap dedup for the "remember X" repeated in one conversation.
4. **Append:** add `- <YYYY-MM-DD>: <fact>` under the last `## Notes` heading, creating the heading at the end of the body when it's missing. The date is local to `FRIDAY_TIMEZONE`, the same key the builtin module reads.
5. **Write** the revision with author `remember` and no sources.

- **Result:** kept small because it is spoken over: `{ stored: true, page, created }`, or `{ stored: false, reason }` with a message the model can relay. For `tombstoned`, the message is "this was deliberately forgotten; the user can recreate it in the portal".
- **Tool description:**
  - Use a person's, place's or project's name as `entity`, and `profile` for facts about the user or household.
  - One fact per call.
  - `[[Name]]` may reference other pages.
  - Friday can't tell voices apart, so facts about the speaker go on the profile unless they say who they are.
- **Why append rather than rewrite:** decided during exploration. Voice latency and a speech-tuned model rewriting documents make read-before-write a poor fit, and the nightly pass tidies. The cost is that, until the nightly pass runs, `brain_recall` can return a stale line and a correcting line together. The date on each line lets the model prefer the newer one, and the context instructions say so.

### D4. Search and `brain_recall`

- **Terms:** take `query` plus `entity`, fold them (NFD, strip combining marks, lower-case), and split on anything that isn't a letter or digit (Unicode classes). Drop terms of 2 characters or fewer and English and Dutch stopwords, then keep at most 8 distinct terms.
- **Score:** for each live non-profile page, count the distinct terms found as substrings of its folded name, aliases and body. A name or alias hit weighs double, so a page named after the term beats one that mentions it. Ties go to the most recently updated.
- **Result:**
  - The exact entity match first (when `entity` resolves), then the top 3 hits that aren't that page.
  - `found_by` is `name`, `search`, or `name+search`.
  - Each page carries `name`, `type`, `aliases`, `body` and `updatedAt`, plus up to 10 connections across the returned pages: outgoing links first, then backlinks, each `{ from, to, line, exists }`.
  - With no hits: `{ found: false, pages: [up to 50 names] }`, so the model can retry with a real name.
- **Profile:** never returned. It is always in the context already.
- **Why not FTS5:** the corpus is tiny. Substring matching catches partial words ("verjaardag" inside "verjaardagen") that FTS tokenization wouldn't without extra configuration, and there is no index to keep in sync. `module-db` supports FTS5 if that ever changes.

### D5. Links are parsed on read

- **Parsing:** the syntax is `/\[\[([^\[\]\n]{1,80})\]\]/g`. Targets resolve through `brain__names` (so aliases work) to live pages. An unresolved target is **dangling**: a valid marker that the page doesn't exist yet.
- **Computing:** backlinks and dangling targets come from scanning live bodies, and a link's context is its line, cut to 160 characters.
- **Rename:** a save that changes the name adds the old name as an alias unless the user removed it in the same save, so inbound links keep resolving.
- **Purge unlinking:** purge rewrites inbound links on live pages from `[[Name]]` to `Name` for the purged page's name and aliases. Each rewrite is its own revision, author `user`, note `unlinked "<name>" after purge`.

### D6. Prompt context: rendered by the module, bounded by the module

The provider renders the same content for `voice` and `chat`:

```
## Memory
You have a long-term memory about the user and their household. Use it as
background knowledge; don't recite it unprompted. Lines under "Notes" are
dated; when two contradict, the newer one holds.

### Profile
<profile body, or "(empty)">

### Pages
Call brain_recall before answering about any of these, or when the user
refers to something you might have noted before:
- Anouk (person; aka Noukie): Sister, lives in Utrecht
- …and 12 more; brain_recall finds them by search.

When the user asks you to remember something, or shares a lasting fact
about their life, call brain_remember.
```

- **Hint:** the first non-empty line of the body that isn't a heading, stripped of markdown markers and cut to 80 characters.
- **Index order:** most recently updated first, excluding the profile.
- **Size bound:** the brain targets 10000 characters, under the platform cap of 12000. When the rendering is longer, it drops index entries from the end, then cuts the profile at a line boundary with a marker. It never goes over the target.
- **Why the budget is soft:** `remember` on the profile is never refused, and truncation only kicks in as a last resort at the size bound. The portal shows `used / budget` for the profile and marks it over budget. Bringing it back under is consolidation's job in `brain-nightly`. Until that ships, the user trims it by hand.
- **Rejected:** refusing a `remember` that would exceed the budget (what jarvis did). In voice, a refused "remember" is awkward and invites the model to paraphrase the fact somewhere else.
- **Cost:** the provider runs two indexed queries (profile, and the top 50 pages by `updated_at`) plus a count. That is well under the platform's 100 ms slow-provider log threshold.

### D7. HTTP routes

All routes are under `/api/modules/brain/`. JSON errors are `{ error, code }` with the D2 codes.

| Route | Result |
|---|---|
| `GET pages` | `{ profile: { id, usedTokens, budgetTokens }, pages: [{ id, name, type, aliases, body, isProfile, updatedAt, revisionId }], deleted: [{ id, name, deletedAt }] }`. Bodies are included so the list can search on the client. |
| `GET pages/:id` | The page, `revisions` (id, author, createdAt, note, sources, newest first), `links` (outgoing `{ target, pageId? }`) and `backlinks` (`{ pageId, name, line }`). Soft-deleted pages are readable too, for the "Recently deleted" view. |
| `GET pages/:id/revisions/:rev` | The full snapshot. |
| `POST pages` | `{ name, type, aliases?, body? }` → 201, or 409 `name_taken`. A user create lifts a tombstone. |
| `PUT pages/:id` | `{ name, type, aliases, body, baseRevision, keepOldName? }` → 200, 409 `stale` (with the current page), 409 `name_taken`, 400 `invalid` or `profile`. `keepOldName` (default true) adds the old name as an alias on a rename; the editor's checkbox sets it (D5). |
| `POST pages/:id/restore` | `{ revisionId, baseRevision }` → 200, a new revision with note `restored revision <n>`. |
| `DELETE pages/:id` | Soft delete → 204. 400 `profile` for the profile. |
| `POST pages/:id/undelete` | 200, or 409 `name_taken` naming the colliding names. |
| `POST pages/:id/purge` | `{ confirm: <exact name> }`. Soft-deleted pages only, otherwise 409 `not_deleted`. A confirm mismatch is 400. Returns `{ unlinked: [names of rewritten pages] }`. |

Purge order inside one transaction:

1. Tombstone the name and aliases, except keys now owned by other live pages.
2. Unlink inbound links (D5).
3. Delete the page, which cascades to its revisions.

### D8. Portal UI

- **Package:** `modules/brain/src/ui/`, with routes `""` (list) and `p/:id` (page). The nav entry is `{ label: "Brain", icon: "brain", order: 20 }`. A `brain` icon is added to `@friday/portal-ui`.
- **List:**
  - A `DataTable` with name, a type chip, aliases, hint and updated time.
  - The profile pinned on top with a budget meter and an over-budget badge.
  - A search input that filters on name, aliases and body on the client.
  - `New page` opens a drawer with name, type and aliases.
  - A collapsible "Recently deleted" card with `Restore` and `Delete forever`. The latter needs the name typed to confirm, then shows which pages were unlinked.
- **Page view:**
  - A header (name, type, aliases) with `Edit` and `Delete` actions. Delete confirms with "It can be restored later", and there is no delete action on the profile.
  - The rendered body.
  - A backlinks card.
  - A `History` tab: revisions with author badge, time, note, and sources linking to `/conversations?id=`. Selecting a revision shows a line diff against its predecessor with `Restore this version`.
- **Edit:**
  - Name, type and alias fields plus a monospace textarea. Name and type are disabled for the profile.
  - A save that comes back `stale` shows "Changed since you opened it (by <author> at <time>)", with `Discard my edits` (reload) and `Overwrite` (resave with the new base). The editor keeps the user's text until they choose.
- **Rendering:**
  - The brain's own `markdown-it` instance with `html: false`, like the portal's chat. Bodies may later be written by a model from conversation content.
  - An inline rule turns `[[Name]]` into an internal link to `p/<id>`, or a dashed "dangling" link that opens `New page` pre-filled with the name.
  - Navigation uses click delegation on the rendered HTML with `router.push`, so no router components are needed inside `v-html`.
- **Pure helpers** (the wikilink rule, line diff, token estimate, hint extraction) live in plain `.ts` files so the module's `node:test` suite covers them without a browser.
- **Rejected alternative:** moving the portal's `renderMarkdown` into `@friday/portal-ui`. It would help reuse, but it touches the chat page, and the brain needs its own link rule anyway.

## Risks / Trade-offs

- **[Risk]** The model files facts under inconsistent names ("Noukie" vs "Anouk") and creates duplicate pages. → The index in context shows existing names and aliases, and the tool description says to reuse them. Merging duplicates is consolidation's job in `brain-nightly`. The portal can rename, add aliases and delete.
- **[Risk]** Contradicting notes until the nightly pass runs. → Notes are dated, and the context says the newer one holds (D3, D6).
- **[Risk]** The profile grows past its budget while `brain-nightly` isn't there yet. → The portal flags it. The context stays bounded by D6's truncation, and the user can trim it.
- **[Risk]** The model stores sensitive facts (codes, health) in plaintext `friday.db`. → Same exposure as the conversation transcripts, which already hold what was said. The portal makes it visible and deletable, and purge removes it from the brain.
- **[Trade-off]** `remember` revisions have no source conversation, because tools don't get one. → Accepted. Revision time plus the Conversations page is enough to trace a fact. If needed later, a platform change could pass call metadata to handlers.
- **[Trade-off]** `GET pages` returns every body. → At household scale that is tens of kilobytes. If it grows, move search to the server with a `?q=` using D4.
- **[Trade-off]** Purge leaves the name in older revisions of other pages and in the transcripts (as in jarvis). → Documented in the purge confirmation text.

## Migration Plan

- Deploying adds the module and runs `brain` migration 1 on first start. There is no data to migrate.
- **Rollback:** removing the module from `modules.ts`, or setting `FRIDAY_MODULES` without `brain`, leaves its tables unused in `friday.db` (see `module-db`).
- `brain` can only be applied after `module-db` is merged.
