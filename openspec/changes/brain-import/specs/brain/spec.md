# Spec Delta

## ADDED Requirements

### Requirement: Jarvis's brain can be imported into an empty brain

The brain SHALL accept an import of one Jarvis user's brain at `POST /api/modules/brain/import`, given as the profile (body and aliases), live pages and soft-deleted pages (each with name, type, aliases, body, and Jarvis's creation and update times), and tombstoned names, together with a `dryRun` flag that defaults to true: only an explicit `dryRun: false` imports. The import SHALL:
- be refused with 409 `not_empty` when the brain holds any page other than the profile, or a profile with a non-empty body or any alias, including soft-deleted pages;
- validate every entry against the brain's page rules (name and alias rules, at most 20 aliases, body length, type), and detect name or alias collisions within the import, reporting each problem with the page it concerns;
- report as warnings, without blocking, tombstoned names that are also names of imported pages (those tombstones are skipped), names this brain had already tombstoned that an imported page brings back, and `[[links]]` whose target the brain would not recognise as a link;
- on a dry run, write nothing and return the report with the counts it would import;
- otherwise, when the report has no blocking problem, apply everything in one transaction: the profile's body and aliases, each live page, each soft-deleted page as soft-deleted, and each tombstone; and write nothing when it has one, or when a write fails inside the transaction, responding 400 `invalid` with the report.

Each imported page SHALL be recorded as one revision with author `user`, dated at the import, and a note stating it was imported from Jarvis. Imported pages SHALL keep Jarvis's creation and update times (and soft-deleted pages their deletion time), so the brain's "most recently updated" order matches Jarvis's. The import SHALL NOT attach source conversations and SHALL NOT import Jarvis's revision history.

#### Scenario: Dry run
- **WHEN** an export with a profile, 12 live pages, 2 deleted pages and 3 tombstones is sent with `dryRun: true` to an empty brain
- **THEN** the response reports those counts and no problems, and the brain is unchanged

#### Scenario: Import
- **WHEN** the same export is sent with `dryRun: false`
- **THEN** the profile has the imported body, the 12 pages are live with one `user` revision each noting the import, the 2 deleted pages are listed under "Recently deleted", and the 3 names are tombstoned

#### Scenario: Forgotten name stays forgotten
- **WHEN** an imported tombstone is `Old job` and the model later calls `brain_remember({ entity: "Old job", fact: "..." })`
- **THEN** no page is created and the result says it was deliberately forgotten

#### Scenario: Brain not empty
- **WHEN** an import is sent while the brain has a page `Anouk`
- **THEN** it is refused with 409 `not_empty` and nothing changes

#### Scenario: Invalid entry
- **WHEN** an export contains a page whose name is 120 characters long, or two pages that share the alias `Noukie`
- **THEN** the dry run reports each problem with the pages involved, and an import with `dryRun: false` is refused with 400 `invalid` and writes nothing

#### Scenario: Recency order
- **WHEN** Jarvis last updated `Car` before `Anouk`
- **THEN** after the import `Anouk` is listed before `Car` in the prompt context's page index
