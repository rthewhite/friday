# Spec Delta

## Purpose

Gives Friday a long-term memory for the household: markdown pages about people, places and projects plus a profile. Friday reads them in every conversation and adds to them when asked to remember something, and the user curates them in the portal with full history.

## ADDED Requirements

### Requirement: The brain holds pages and exactly one profile

The `brain` module SHALL store pages, each with an id, a name, a type (`person`, `place`, `project` or `other`), a list of aliases, a markdown body, and its creation, update and deletion times. There SHALL be exactly one profile page, holding facts about the user and the household. It SHALL exist from the module's first start, and SHALL NOT be deletable, renamable or retypable. All pages SHALL belong to the one household; pages are not scoped per person.

#### Scenario: First start
- **WHEN** the brain module loads against a database that has never held it
- **THEN** the brain holds one page: an empty profile

#### Scenario: Profile is protected
- **WHEN** a request tries to delete the profile, or to change its name or type
- **THEN** it is refused with code `profile`, and the profile is unchanged

### Requirement: Names and aliases are unique among live pages

A page's name and aliases SHALL be unique across all live pages, comparing case-insensitively and ignoring surrounding and repeated whitespace. A name or alias SHALL be 1 to 80 characters, SHALL NOT contain a newline, `[[` or `]]`, and SHALL NOT be `profile` for a page other than the profile. A page SHALL have at most 20 aliases. A write that would duplicate a live page's name or alias SHALL be refused with code `name_taken`, naming the colliding name. The names of soft-deleted pages SHALL be free for other pages to use.

#### Scenario: Alias collides with a name
- **WHEN** page `Anouk` exists and another page is saved with alias `anouk`
- **THEN** the save is refused with `name_taken` naming `anouk`

#### Scenario: Name of a deleted page
- **WHEN** page `Old car` is soft-deleted and a new page `Old car` is created
- **THEN** the new page is created

### Requirement: Every change is recorded as a revision

Every change to a page SHALL record a revision holding the full name, type, aliases and body after the change, the author (`system`, `user`, `remember`, `extraction` or `consolidation`), the revision it was based on, the source conversation ids when known, an optional note, and its time. A page's revisions SHALL be kept until the page is purged. Saving with a base revision that is no longer the page's current revision SHALL be refused with code `stale`, returning the current page.

#### Scenario: Edit in the portal
- **WHEN** the user saves a page in the portal
- **THEN** a revision with author `user` and the full new body is recorded, based on the revision the user opened

#### Scenario: Concurrent change
- **WHEN** the user opened a page at revision 4, `brain_remember` then appended to it (revision 5), and the user saves based on 4
- **THEN** the save is refused with `stale` and the response carries revision 5

### Requirement: brain_remember appends a dated note

The module SHALL register a tool `brain_remember` with parameters `entity` (required), `fact` (required) and `type` (optional, one of the page types), offered in both channels. It SHALL:
- clean `fact` to a single trimmed line, and refuse it when empty or longer than 500 characters;
- resolve `entity` to the profile when it is `profile` (case-insensitive), otherwise to the live page whose name or alias matches it;
- create a page named `entity` with the given type (default `other`) when nothing matches;
- append `- <date>: <fact>` under the page's `## Notes` heading, adding the heading at the end of the body when missing, with the date in `FRIDAY_TIMEZONE`;
- record the change as one revision with author `remember`.

It SHALL NOT remove or change any existing text. When the page already contains the fact (case-insensitive), it SHALL write nothing and report that the fact was already known. The result SHALL state whether the fact was stored, the page name, and whether the page was created.

#### Scenario: New person
- **WHEN** no page matches `Anouk` and the model calls `brain_remember({ entity: "Anouk", fact: "Birthday is 3 November", type: "person" })` on 29 September 2026
- **THEN** a person page `Anouk` exists whose body has a `## Notes` section with `- 2026-09-29: Birthday is 3 November`, and the result says it was stored on a new page

#### Scenario: Alias resolves
- **WHEN** page `Anouk` has alias `Noukie` and the model remembers a fact for `noukie`
- **THEN** the note is appended to `Anouk`, and no new page is created

#### Scenario: Existing content is kept
- **WHEN** a note is appended to a page whose body has an intro paragraph and an earlier note
- **THEN** the intro and the earlier note are unchanged, and the new note follows the earlier one

#### Scenario: Repeated fact
- **WHEN** the model remembers a fact the page already contains
- **THEN** nothing is written and the result says it was already known

#### Scenario: Profile fact
- **WHEN** the model calls `brain_remember({ entity: "profile", fact: "Prefers Celsius" })`
- **THEN** the note is appended to the profile

### Requirement: Forgotten names stay forgotten

A name or alias of a purged page SHALL be tombstoned. Writes by any author other than `user` SHALL be refused with code `tombstoned` when they would create or name a page with a tombstoned name. In particular, `brain_remember` SHALL NOT create a page with a tombstoned name, and its result SHALL tell the model the entity was deliberately forgotten and can be recreated in the portal. A page created or renamed by the user SHALL lift the tombstone for its names.

#### Scenario: Remember after purge
- **WHEN** page `Old job` was purged and the model calls `brain_remember({ entity: "Old job", fact: "..." })`
- **THEN** no page is created and the result says it was deliberately forgotten

#### Scenario: User recreates it
- **WHEN** the user creates page `Old job` in the portal after it was purged
- **THEN** the page is created and later `brain_remember` calls for `Old job` append to it

### Requirement: Friday cannot delete or rewrite memories

The brain SHALL offer the model no tool that deletes pages, removes text, or replaces a page's body. Purging SHALL be possible only through the brain's HTTP routes used by the portal. Deleting and rewriting SHALL be possible only through those routes and through the brain's own scheduled maintenance, which can soft-delete a page only by merging it into another.

#### Scenario: Tool list
- **WHEN** the brain module is loaded
- **THEN** its only tools are `brain_remember` and `brain_recall`

### Requirement: brain_recall finds pages by name and by search

The module SHALL register a tool `brain_recall` with parameters `query` (required) and `entity` (optional), offered in both channels. The search SHALL:
- take the words of `query` and `entity`, compared without case and accents;
- ignore words of 2 characters or fewer and common English and Dutch stopwords;
- use at most 8 distinct words;
- score each live page other than the profile by how many of the words occur in its name, aliases or body, weighting name and alias matches higher.

The result SHALL contain the page whose name or alias matches `entity` exactly, when there is one, followed by up to 3 other best-scoring pages. Each page SHALL carry its name, type, aliases, body and update time. The result SHALL also carry up to 10 connections of the returned pages: outgoing links first, then backlinks, each with the linking line and whether the target page exists. When nothing matches, the result SHALL say so and list the names of up to 50 pages. The profile SHALL NOT be returned.

#### Scenario: Name lookup plus search
- **WHEN** page `Anouk` exists, page `Family` mentions Anouk, and the model calls `brain_recall({ entity: "Anouk", query: "Anouk birthday" })`
- **THEN** the result has `Anouk` first and `Family` among the other pages

#### Scenario: Topic search finds a fact filed elsewhere
- **WHEN** page `Home` contains "Wifi password is on the router label" and the model calls `brain_recall({ query: "wifi password" })`
- **THEN** the result includes `Home`

#### Scenario: Accent-insensitive
- **WHEN** a page mentions "café" and the query is "cafe"
- **THEN** the page is found

#### Scenario: Nothing found
- **WHEN** no page matches the query
- **THEN** the result says nothing was found and lists existing page names

### Requirement: Pages link to each other with double brackets

A body MAY reference other pages as `[[Name]]`. A link SHALL resolve through names and aliases of live pages, and SHALL be dangling when nothing matches. For each page, the brain SHALL report its outgoing links (resolved or dangling) and its backlinks (live pages linking to it, with the linking line). Links SHALL be derived from bodies on each read, never stored separately. When a page is renamed, its old name SHALL become an alias unless the same save removes it.

#### Scenario: Backlink
- **WHEN** page `Family` contains `[[Anouk]]`
- **THEN** page `Anouk` reports a backlink from `Family` with that line

#### Scenario: Rename keeps links working
- **WHEN** page `Anouk` is renamed to `Anouk de Wit`
- **THEN** `Anouk` is an alias of it and `[[Anouk]]` in `Family` still resolves to it

#### Scenario: Dangling link
- **WHEN** a body contains `[[Utrecht]]` and no page matches
- **THEN** that link is reported as dangling

### Requirement: The brain adds its memory to every conversation prompt

The module SHALL contribute prompt context for both channels containing:
- instructions to treat memory as background, to prefer the newer of two contradicting dated notes, to call `brain_recall` for listed pages and anything that may have been noted before, and to call `brain_remember` when the user asks to remember something or shares a lasting fact;
- the profile body in full;
- an index of up to 50 live pages other than the profile, most recently updated first, each with name, type, aliases and a hint from its first line of text, plus the number of further pages when there are more.

The context SHALL stay under 10000 characters: entries SHALL be dropped from the end of the index first, and only then SHALL the profile be cut at a line boundary with a marker. The instructions SHALL be present even when the brain is empty.

#### Scenario: Session opens with memory
- **WHEN** the profile says "Lives in Amsterdam" and page `Anouk` exists, and a voice session opens
- **THEN** the system instruction contains the profile text and an index line for `Anouk`

#### Scenario: Empty brain
- **WHEN** the brain holds only an empty profile
- **THEN** the context still tells the model it can call `brain_remember`

#### Scenario: Many pages
- **WHEN** the brain holds 80 pages besides the profile
- **THEN** the index lists the 50 most recently updated and says there are 30 more

### Requirement: The profile budget is a soft limit

The profile SHALL have a token budget from `BRAIN_PROFILE_TOKEN_BUDGET` (default 800), with tokens estimated as characters divided by 4, rounded up. `brain_remember` on the profile SHALL NOT be refused because of the budget. The brain SHALL report the profile's estimated tokens and the budget to the portal, which SHALL mark the profile as over budget when it exceeds it.

#### Scenario: Remember beyond the budget
- **WHEN** the profile is at 790 of 800 tokens and the model remembers a 100-character profile fact
- **THEN** the note is stored and the portal shows the profile over budget

### Requirement: Pages API

The module SHALL serve under `/api/modules/brain/`:
- `GET pages`: the profile's estimated tokens and budget, all live pages with bodies, and soft-deleted pages with name and deletion time.
- `GET pages/:id`: one page, live or soft-deleted, with its revisions newest first (id, author, time, note, sources), outgoing links and backlinks.
- `GET pages/:id/revisions/:revision`: a revision's full snapshot.
- `POST pages`: create a page with author `user`, responding 201.
- `PUT pages/:id`: save name, type, aliases and body based on a given revision.
- `POST pages/:id/restore`: make a given revision's content current as a new revision with author `user` and a note naming the restored revision.

Errors SHALL respond with a code: 400 `invalid` or `profile`, 404 `not_found`, and 409 `name_taken`, `stale` or `tombstoned`.

#### Scenario: Save and read back
- **WHEN** the portal saves page `Anouk` with a new body based on its current revision
- **THEN** `GET pages/:id` returns the new body and a newest revision with author `user`

#### Scenario: Restore
- **WHEN** the user restores revision 3 of a page whose current revision is 6
- **THEN** revision 7 is recorded with revision 3's content and the note `restored revision 3`, and revisions 3 to 6 remain

### Requirement: Pages are soft-deleted and can be restored

`DELETE pages/:id` SHALL mark a live page other than the profile as deleted, keeping its revisions, and respond 204. A deleted page SHALL no longer appear in recall, the prompt context, name resolution or link resolution. `POST pages/:id/undelete` SHALL make it live again with its names, and SHALL be refused with `name_taken` when any of its names is now used by a live page.

#### Scenario: Delete and undelete
- **WHEN** the user deletes page `Anouk` and later undeletes it
- **THEN** in between, `brain_recall` doesn't return it and the context doesn't list it; afterwards both do again, with its history intact

#### Scenario: Undelete after the name was reused
- **WHEN** page `Old car` was deleted, a new `Old car` was created, and the user undeletes the first
- **THEN** the undelete is refused with `name_taken` naming `Old car`

### Requirement: Purging forgets a page permanently

`POST pages/:id/purge` SHALL accept only a soft-deleted page and only with `confirm` equal to its name. Otherwise it SHALL be refused with 409 for a live page, or 400 for a mismatched confirmation. In one transaction, purge SHALL:
- tombstone the page's name and aliases, except names now used by other live pages;
- rewrite every `[[link]]` to those names in live pages into plain text, each as a revision with author `user` and a note naming the purged page;
- delete the page and all its revisions.

The response SHALL list the pages whose links were rewritten.

#### Scenario: Purge
- **WHEN** the user purges deleted page `Old job`, and page `Profile` contains "Worked at [[Old job]]"
- **THEN** `Old job` and its revisions no longer exist, `Profile` now reads "Worked at Old job" in a new revision, `Old job` is tombstoned, and the response lists `Profile`

#### Scenario: Purge a live page
- **WHEN** a purge request targets a live page
- **THEN** it is refused with 409 and nothing changes

### Requirement: Brain page in the portal

The portal SHALL offer a `Brain` entry under `Modules` opening `/m/brain`. The page SHALL list:
- the profile pinned first, with its estimated tokens against the budget and an over-budget mark;
- the live pages with name, type, aliases, hint and update time;
- a search box that filters the list by name, alias and body text;
- a `New page` action asking for name, type and aliases;
- a "Recently deleted" section with `Restore`, and a permanent delete that requires typing the page's name, states that transcripts and other pages' history may still mention it, and then shows which pages were unlinked.

#### Scenario: Find a page
- **WHEN** the user types "utrecht" in the search box
- **THEN** only pages whose name, aliases or body mention Utrecht remain listed

#### Scenario: Permanent delete
- **WHEN** the user permanently deletes a page and types its name to confirm
- **THEN** it disappears from "Recently deleted" and the portal lists the pages that were unlinked

### Requirement: Viewing and editing a page in the portal

Opening a page SHALL show its name, type and aliases, its rendered body, and its backlinks. The body SHALL be rendered as markdown with raw HTML shown as text, never interpreted. Resolved `[[links]]` SHALL navigate to the linked page. Dangling links SHALL be marked and offer to create the page with that name. `Edit` SHALL allow changing name, type, aliases and body, with name and type fixed for the profile. When a save is refused as `stale`, the editor SHALL keep the user's text, say who changed the page and when, and offer to discard the edits or overwrite. `Delete` SHALL ask for confirmation, stating the page can be restored later, and SHALL be absent for the profile.

#### Scenario: Follow a link
- **WHEN** the user clicks `[[Anouk]]` in the body of `Family`
- **THEN** the portal shows page `Anouk`

#### Scenario: HTML in a body
- **WHEN** a page body contains `<img src=x onerror=alert(1)>`
- **THEN** the text is shown literally and no script runs

#### Scenario: Edit conflict
- **WHEN** the user edits a page while `brain_remember` appends to it, and then saves
- **THEN** the editor shows that the page changed by `remember`, with the user's text still in the editor

### Requirement: Page history in the portal

The page view SHALL show the revision history, newest first, with author, time, note and links to source conversations when present. Selecting a revision SHALL show a line diff against the revision before it and offer `Restore this version`.

#### Scenario: Undo a change
- **WHEN** the user opens the history, selects the revision before an unwanted change and restores it
- **THEN** the page shows that content again, and the history has a new `user` revision noting the restore
