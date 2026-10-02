## MODIFIED Requirements

### Requirement: brain_remember appends a dated note

The module SHALL register a tool `brain_remember` with parameters `entity` (required), `fact` (required) and `type` (optional, one of the page types), offered in both channels. Its description SHALL tell the model:
- to use the name of the person, place, project or organisation a fact is about as `entity`, also when the user says it in the first person ("my sister Anouk…"), and to include the relation to the user in the fact;
- to use `profile` only for facts about the user themselves or the household as a whole.

The tool SHALL:
- clean `fact` to a single trimmed line, and refuse it when empty or longer than 500 characters;
- resolve `entity` to the profile when it is `profile` (case-insensitive), otherwise to the live page whose name or alias matches it;
- create a page named `entity` with the given type (default `other`) when nothing matches;
- append `- <date>: <fact>` under the page's `## Notes` heading, adding the heading at the end of the body when missing, with the date in `FRIDAY_TIMEZONE`;
- record the change as one revision with author `remember`.

It SHALL NOT remove or change any existing text. When the fact repeats the page's latest dated note, or a note dated the same day (case-insensitive), it SHALL write nothing and report that the fact was already known. A fact that only repeats an older note SHALL be appended, because it is a correction. The result SHALL state whether the fact was stored, the page name, and whether the page was created.

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

#### Scenario: Profile fact
- **WHEN** the model calls `brain_remember({ entity: "profile", fact: "Prefers Celsius" })`
- **THEN** the note is appended to the profile

#### Scenario: Description routes facts to entities
- **WHEN** the brain module is loaded
- **THEN** `brain_remember`'s description says that a fact about a named person, place, project or organisation goes on that entity, also when said in the first person, and that `profile` is for facts about the user or the household as a whole

### Requirement: The brain adds its memory to every conversation prompt

The module SHALL contribute prompt context for both channels containing:
- instructions to treat memory as background, to prefer the newer of two contradicting dated notes, to call `brain_recall` for listed pages and anything that may have been noted before, and to call `brain_remember` when the user asks to remember something or shares a lasting fact;
- a statement that the profile is a summary, and that the details about the people, places and projects it names are on their pages;
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

#### Scenario: Profile as a summary
- **WHEN** a session opens
- **THEN** the memory instructions say that the profile is a summary and that details are on the pages, found with `brain_recall`
