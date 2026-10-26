# Spec Delta

## ADDED Requirements

### Requirement: The subject page is the user's page

The brain SHALL hold exactly one subject page: a live `person` page holding facts about the user, referenced by the profile. The subject page SHALL NOT be deletable, and its type SHALL NOT be changeable; such requests SHALL be refused with code `profile`. The user SHALL be able to rename it and change its aliases like any page. Writes by any author other than `user` SHALL NOT change its name or type. The subject page SHALL take part in recall, the page index, links and backlinks like any other page.

#### Scenario: Subject is protected
- **WHEN** a request tries to delete the subject page, or to change its type
- **THEN** it is refused with code `profile`, and the page is unchanged

#### Scenario: Rename by the user
- **WHEN** the user renames the subject page from `Me` to `Raymond`
- **THEN** the page is named `Raymond`, `Me` is among its aliases, and it is still the subject

#### Scenario: Recall about the user
- **WHEN** the subject page says "Plays iRacing with friends" and the model calls `brain_recall({ query: "iRacing" })`
- **THEN** the result includes the subject page

### Requirement: The profile's instructions are written only by the user

The profile SHALL hold instructions: plain text of at most 2000 characters with the user's standing preferences for how Friday behaves. Instructions SHALL be written only through the pages API with author `user`. No tool, no extraction and no consolidation SHALL write them. A save of instructions longer than 2000 characters SHALL be refused with code `invalid`. An instructions save SHALL be refused as `stale` only when the instructions changed after its base revision; a newer revision that changed only the profile's summary SHALL NOT make it stale.

#### Scenario: Save instructions
- **WHEN** the user saves the instructions "Call me Ray. In voice, keep answers short."
- **THEN** the profile's instructions are that text, recorded as a revision with author `user`

#### Scenario: Summary changed meanwhile
- **WHEN** the user opened the profile at revision 4, the nightly pass then wrote a new summary (revision 5), and the user saves instructions based on 4
- **THEN** the save succeeds, and the profile keeps the summary of revision 5

#### Scenario: Instructions changed meanwhile
- **WHEN** the user saved instructions in one tab (revision 5) and saves other instructions in a second tab based on revision 4
- **THEN** the save is refused with `stale` and the response carries revision 5

#### Scenario: Not writable by tools
- **WHEN** a conversation says "from now on, always answer in English" and the model calls `brain_remember({ entity: "me", fact: "Prefers answers in English" })`
- **THEN** the fact is appended to the subject page, and the profile's instructions are unchanged

#### Scenario: Too long
- **WHEN** the user saves instructions of 2500 characters
- **THEN** the save is refused with `invalid` and the instructions are unchanged

### Requirement: Non-user writes link mentions of pages

When a write by `remember`, `extraction` or `consolidation` adds text to a page, including the profile's summary, the brain SHALL link mentions of other pages in the added text before recording the revision. For `remember` and `extraction` the added text is the appended note. For a rewrite, a created page, a merge or a summary it is the whole new body. For each live page other than the written page and the profile whose name or alias:
- is at least 3 characters long,
- occurs in the added text as a whole word with the same letter case,
- not inside an existing `[[link]]`, inline code or a code block,
- and is not already linked anywhere in the page's body,

the first such occurrence SHALL be wrapped as `[[<occurrence>]]`. Longer names and aliases SHALL be matched before shorter ones, and an occurrence SHALL NOT overlap another. Writes by `user` and `system` SHALL be stored as written.

#### Scenario: Summary mentions a page
- **WHEN** pages `Home` and `Schuberg Philis` exist and the nightly pass writes the summary "Lives at Home in Almere. Works at Schuberg Philis."
- **THEN** the stored summary reads "Lives at [[Home]] in Almere. Works at [[Schuberg Philis]]."

#### Scenario: Lowercase word
- **WHEN** page `Home` exists and `brain_remember` appends "Works from home on Fridays" to the subject page
- **THEN** the note is stored without a link

#### Scenario: Longest name wins
- **WHEN** pages `Honda` and `Honda CB900F` exist and a consolidation rewrite mentions "Honda CB900F"
- **THEN** the text holds `[[Honda CB900F]]`, not `[[Honda]] CB900F`

#### Scenario: Already linked
- **WHEN** a page body already contains `[[Lisa]]` and `brain_remember` appends a note mentioning Lisa to it
- **THEN** the note is stored without a second link

#### Scenario: User's edit untouched
- **WHEN** the user saves a page mentioning `Home` without brackets
- **THEN** the body is stored as typed

#### Scenario: Short name
- **WHEN** the subject page is named `Me` and a consolidation rewrite contains "Me and Lisa went to Utrecht"
- **THEN** `Me` is not linked

### Requirement: Existing brains move the profile to the subject page

When the brain module first loads against a brain that has no subject page, it SHALL in one transaction:
- create a `person` page named `Me`, or `Me 2`, `Me 3` and so on when that name is taken by a live page or tombstoned, whose body is the profile's current body, as a revision with author `system` and the note `moved from the profile`;
- make it the subject page;
- keep the profile's body as its summary until the first summary is generated;
- set the profile's instructions to empty.

#### Scenario: Upgrade
- **WHEN** the profile's body says "Has two cats: Oreo and Sylvester" and the module loads the new version for the first time
- **THEN** a subject page `Me` holds that body with a `system` revision noting `moved from the profile`, the profile's summary still says it, and the instructions are empty

#### Scenario: Name taken
- **WHEN** a live page `Me` already exists at upgrade
- **THEN** the subject page is named `Me 2`

#### Scenario: Fresh brain
- **WHEN** the brain module loads against a database that has never held it
- **THEN** the brain holds an empty profile and an empty subject page `Me`

## MODIFIED Requirements

### Requirement: The brain holds pages and exactly one profile

The `brain` module SHALL store pages, each with an id, a name, a type (`person`, `place`, `project` or `other`), a list of aliases, a markdown body, and its creation, update and deletion times. There SHALL be exactly one profile page. Its body is the summary of the brain, generated by the nightly pass, and it additionally holds the user's instructions and a reference to the subject page. It SHALL exist from the module's first start, and SHALL NOT be deletable, renamable or retypable. Its body SHALL be written only by the nightly pass, the migration, the reverting of a nightly run, and a purge turning links to the purged page into plain text. All pages SHALL belong to the one household; pages are not scoped per person.

#### Scenario: First start
- **WHEN** the brain module loads against a database that has never held it
- **THEN** the brain holds an empty profile, with empty instructions, and an empty subject page

#### Scenario: Profile is protected
- **WHEN** a request tries to delete the profile, or to change its name, type or body
- **THEN** it is refused with code `profile`, and the profile is unchanged

### Requirement: Every change is recorded as a revision

Every change to a page SHALL record a revision holding the full name, type, aliases and body after the change, and for the profile also its instructions, the author (`system`, `user`, `remember`, `extraction` or `consolidation`), the revision it was based on, the source conversation ids when known, an optional note, and its time. A page's revisions SHALL be kept until the page is purged. Saving with a base revision that is no longer the page's current revision SHALL be refused with code `stale`, returning the current page, except for a profile instructions save, which is stale only when the instructions changed after its base. Revision ids SHALL increase with every revision written across the whole brain and SHALL never be reused, including after a purge deleted the newest revisions, so that "revisions since id N" never misses a write.

#### Scenario: Edit in the portal
- **WHEN** the user saves a page in the portal
- **THEN** a revision with author `user` and the full new body is recorded, based on the revision the user opened

#### Scenario: Concurrent change
- **WHEN** the user opened a page at revision 4, `brain_remember` then appended to it (revision 5), and the user saves based on 4
- **THEN** the save is refused with `stale` and the response carries revision 5

#### Scenario: Ids after a purge
- **WHEN** the newest revisions, up to id 120, belonged to a page that is then purged, and another page is saved
- **THEN** the new revision's id is greater than 120

#### Scenario: Profile revision holds both parts
- **WHEN** the nightly pass writes a new summary
- **THEN** the profile's new revision holds the new summary and the unchanged instructions

### Requirement: brain_remember appends a dated note

The module SHALL register a tool `brain_remember` with parameters `entity` (required), `fact` (required) and `type` (optional, one of the page types), offered in both channels. Its description SHALL tell the model:
- to use the name of the person, place, project, organisation, hobby, belonging or pet a fact is about as `entity`, also when the user says it in the first person ("my sister Anouk…", "my Honda…"), and to include the relation to the user in the fact;
- to use `me` only for facts about the user themselves, including how they like Friday to behave;
- to use the household's home page (for example `Home`) for facts about the household as a whole.

The tool SHALL:
- clean `fact` to a single trimmed line, and refuse it when empty or longer than 500 characters;
- resolve `entity` to the subject page when it is `me` or `profile` (case-insensitive), otherwise to the live page whose name or alias matches it;
- create a page named `entity` with the given type (default `other`) when nothing matches;
- append `- <date>: <fact>` under the page's `## Notes` heading, adding the heading at the end of the body when missing, with the date in `FRIDAY_TIMEZONE`;
- record the change as one revision with author `remember`.

It SHALL NOT remove or change any existing text, and SHALL NOT write to the profile. When the fact repeats the page's latest dated note, or a note dated the same day (case-insensitive), it SHALL write nothing and report that the fact was already known. A fact that only repeats an older note SHALL be appended, because it is a correction. The result SHALL state whether the fact was stored, the page name, and whether the page was created.

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
- **WHEN** the model remembers a fact that the page's latest note, or a note from the same day, already states
- **THEN** nothing is written and the result says it was already known

#### Scenario: Correction back to an older fact
- **WHEN** the notes say "Lives in Utrecht" and later "Lives in Amsterdam", and the model remembers "Lives in Utrecht" on a later day
- **THEN** the fact is appended as the newest note

#### Scenario: Fact about the user
- **WHEN** the subject page is named `Raymond` and the model calls `brain_remember({ entity: "me", fact: "Prefers Celsius" })`
- **THEN** the note is appended to `Raymond`, the profile is unchanged, and the result names `Raymond`

#### Scenario: Profile fact
- **WHEN** the model calls `brain_remember({ entity: "profile", fact: "Prefers Celsius" })`
- **THEN** the note is appended to the subject page, and the profile is unchanged

#### Scenario: Description routes facts to entities
- **WHEN** the brain module is loaded
- **THEN** `brain_remember`'s description says that a fact about a named person, place, project, organisation, hobby, belonging or pet goes on that entity, also when said in the first person, that `me` is for facts about the user themselves, and that household facts go on the household's home page

### Requirement: The brain adds its memory to every conversation prompt

The module SHALL contribute prompt context for both channels containing, in this order:
- when the profile's instructions are not empty: a block introducing them as the user's own standing instructions for Friday to follow, which do not change how Friday uses tools or ends conversations, followed by the instructions in full;
- instructions to treat memory as background, to prefer the newer of two contradicting dated notes, to call `brain_recall` for listed pages and anything that may have been noted before, and to call `brain_remember` when the user asks to remember something or shares a lasting fact;
- a statement that the profile is a summary generated from the pages, and that the details about everything it names are on their pages;
- the profile's summary in full;
- an index of up to 50 live pages other than the profile, most recently updated first, each with name, type, aliases and a hint from its first line of text, plus the number of further pages when there are more.

The context SHALL stay under 10000 characters: entries SHALL be dropped from the end of the index first, and only then SHALL the summary be cut at a line boundary with a marker. The instructions SHALL never be cut. The memory instructions SHALL be present even when the brain is empty.

#### Scenario: Session opens with memory
- **WHEN** the summary says "Lives in Amsterdam" and page `Anouk` exists, and a voice session opens
- **THEN** the system instruction contains the summary text and an index line for `Anouk`

#### Scenario: Empty brain
- **WHEN** the brain holds only an empty profile and an empty subject page
- **THEN** the context still tells the model it can call `brain_remember`, and has no instructions block

#### Scenario: Many pages
- **WHEN** the brain holds 80 pages besides the profile
- **THEN** the index lists the 50 most recently updated and says there are 30 more

#### Scenario: Profile as a summary
- **WHEN** a session opens
- **THEN** the memory instructions say that the profile is a summary generated from the pages and that details are on the pages, found with `brain_recall`

#### Scenario: Instructions come first
- **WHEN** the instructions say "Call me Ray." and a chat turn starts
- **THEN** the context begins with the instructions block holding "Call me Ray.", before the memory instructions and the summary

#### Scenario: Instructions are never cut
- **WHEN** the instructions are 2000 characters and the summary and index together would exceed the limit
- **THEN** index entries are dropped and the summary is cut, and the instructions are present in full

### Requirement: Pages API

The module SHALL serve under `/api/modules/brain/`:
- `GET pages`: the profile's instructions, the subject page's id, the summary's estimated tokens and the budget, all live pages with bodies, and soft-deleted pages with name and deletion time.
- `GET pages/:id`: one page, live or soft-deleted, with its revisions newest first (id, author, time, note, sources), outgoing links and backlinks, and whether it is the subject page; for the profile also its instructions.
- `GET pages/:id/revisions/:revision`: a revision's full snapshot, for the profile including its instructions.
- `POST pages`: create a page with author `user`, responding 201.
- `PUT pages/:id`: save name, type, aliases and body based on a given revision. For the profile it SHALL accept only instructions, and SHALL refuse a changed name, type, aliases or body with `profile`.
- `POST pages/:id/restore`: make a given revision's content current as a new revision with author `user` and a note naming the restored revision. For the profile it SHALL restore only that revision's instructions, keeping the current summary.

Errors SHALL respond with a code: 400 `invalid` or `profile`, 404 `not_found`, and 409 `name_taken`, `stale`, `tombstoned` or `not_deleted` (a purge of a page that isn't deleted).

#### Scenario: Save and read back
- **WHEN** the portal saves page `Anouk` with a new body based on its current revision
- **THEN** `GET pages/:id` returns the new body and a newest revision with author `user`

#### Scenario: Restore
- **WHEN** the user restores revision 3 of a page whose current revision is 6
- **THEN** revision 7 is recorded with revision 3's content and the note `restored revision 3`, and revisions 3 to 6 remain

#### Scenario: Restore the profile's instructions
- **WHEN** the user restores a profile revision whose instructions differ from the current ones, and the summary changed since
- **THEN** the new revision holds the restored instructions and the current summary

#### Scenario: Summary is not editable
- **WHEN** a request saves the profile with a changed body
- **THEN** it is refused with `profile`, and the profile is unchanged

### Requirement: Pages are soft-deleted and can be restored

`DELETE pages/:id` SHALL mark a live page other than the profile and the subject page as deleted, keeping its revisions, and respond 204. A deleted page SHALL no longer appear in recall, the prompt context, name resolution or link resolution. `POST pages/:id/undelete` SHALL make it live again with its names, and SHALL be refused with `name_taken` when any of its names is now used by a live page.

#### Scenario: Delete and undelete
- **WHEN** the user deletes page `Anouk` and later undeletes it
- **THEN** in between, `brain_recall` doesn't return it and the context doesn't list it; afterwards both do again, with its history intact

#### Scenario: Undelete after the name was reused
- **WHEN** page `Old car` was deleted, a new `Old car` was created, and the user undeletes the first
- **THEN** the undelete is refused with `name_taken` naming `Old car`

#### Scenario: Subject cannot be deleted
- **WHEN** `DELETE pages/:id` targets the subject page
- **THEN** it is refused with `profile` and the page stays live

### Requirement: Brain page in the portal

The portal SHALL offer a `Brain` entry under `Modules` opening `/m/brain`. The page SHALL list:
- the profile pinned first, with its summary's estimated tokens against the budget and an over-budget mark;
- the subject page pinned second, marked as the user's page; while it is named `Me`, a prompt asking the user to give it their name;
- the other live pages with name, type, aliases, hint and update time;
- a search box that filters the list by name, alias and body text;
- a `New page` action asking for name, type and aliases;
- a "Recently deleted" section with `Restore`, and a permanent delete that requires typing the page's name, states that transcripts and other pages' history may still mention it, and then shows which pages were unlinked.

#### Scenario: Find a page
- **WHEN** the user types "utrecht" in the search box
- **THEN** only pages whose name, aliases or body mention Utrecht remain listed

#### Scenario: Permanent delete
- **WHEN** the user permanently deletes a page and types its name to confirm
- **THEN** it disappears from "Recently deleted" and the portal lists the pages that were unlinked

#### Scenario: Name your page
- **WHEN** the subject page is named `Me` and the user opens the brain page
- **THEN** the subject page is listed second, marked as the user's page, with a prompt to give it their name

### Requirement: Viewing and editing a page in the portal

Opening a page SHALL show its name, type and aliases, its rendered body, and its backlinks. The body SHALL be rendered as markdown with raw HTML shown as text, never interpreted. Resolved `[[links]]` SHALL navigate to the linked page. Dangling links SHALL be marked and offer to create the page with that name. `Edit` SHALL allow changing name, type, aliases and body, with the type fixed for the subject page. When a save is refused as `stale`, the editor SHALL keep the user's text, say who changed the page and when, and offer to discard the edits or overwrite. `Delete` SHALL ask for confirmation, stating the page can be restored later, and SHALL be absent for the profile and the subject page.

Opening the profile SHALL show:
- its instructions, with an `Edit` that changes only the instructions, saved with the same stale handling;
- its summary, rendered like a page body, read-only, with the time it was last generated;
- a `Run nightly now` action that starts the brain's nightly job and says when the job is already running.

#### Scenario: Follow a link
- **WHEN** the user clicks `[[Anouk]]` in the body of `Family`
- **THEN** the portal shows page `Anouk`

#### Scenario: HTML in a body
- **WHEN** a page body contains `<img src=x onerror=alert(1)>`
- **THEN** the text is shown literally and no script runs

#### Scenario: Edit conflict
- **WHEN** the user edits a page while `brain_remember` appends to it, and then saves
- **THEN** the editor shows that the page changed by `remember`, with the user's text still in the editor

#### Scenario: Edit instructions
- **WHEN** the user opens the profile, edits the instructions and saves
- **THEN** the profile shows the new instructions and the unchanged summary

#### Scenario: Summary links
- **WHEN** the summary contains `[[Home]]` and the user clicks it
- **THEN** the portal shows page `Home`

### Requirement: Page history in the portal

The page view SHALL show the revision history, newest first, with author, time, note and links to source conversations when present. Selecting a revision SHALL show a line diff against the revision before it and offer `Restore this version`. For the profile, the diff SHALL show the instructions and the summary, and the action SHALL be `Restore these instructions`, restoring only the instructions.

#### Scenario: Undo a change
- **WHEN** the user opens the history, selects the revision before an unwanted change and restores it
- **THEN** the page shows that content again, and the history has a new `user` revision noting the restore

#### Scenario: Undo an instructions edit
- **WHEN** the user selects an older profile revision and chooses `Restore these instructions`
- **THEN** the profile has that revision's instructions and its current summary

## REMOVED Requirements

### Requirement: The profile budget is a soft limit

**Reason**: Nothing appends to the profile any more, so the budget can no longer be exceeded by `brain_remember`. It now bounds the generated summary (see brain-maintenance, "The nightly pass generates the profile summary").
**Migration**: `BRAIN_PROFILE_TOKEN_BUDGET` keeps its meaning and default. The portal keeps showing the summary's estimated tokens against it; a summary over budget can only exist right after the upgrade, until the first generation.
