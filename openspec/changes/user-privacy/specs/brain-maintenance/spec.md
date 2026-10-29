## ADDED Requirements

### Requirement: The nightly pass runs per user

A run of `brain/nightly` SHALL handle every user from `ctx.users.list()` in turn. For each user, extraction SHALL read only that user's conversations, consolidation and the summary SHALL work only on that user's brain, and the watermarks and guidance markers SHALL be kept per user. A failure for one user SHALL be recorded for that user and SHALL NOT stop the others. The run's job summary SHALL hold counts only (users handled, notes, pages, failures), never page names or conversation text.

#### Scenario: Two users
- **WHEN** the owner and member `Sanne` each had a conversation since the last run
- **THEN** each conversation's notes land in its own user's brain, and the job summary states counts only

#### Scenario: One user fails
- **WHEN** consolidation fails for Sanne
- **THEN** the owner's brain is still handled, Sanne's run is recorded as failed, and the job's summary starts with `partial` (jobs have no partial outcome; the job itself records `ok`)

### Requirement: Users run and review their own nightly passes

Every nightly run recorded in the brain SHALL belong to the user whose brain it handled. `GET runs`, `GET runs/:id` and revert SHALL show and act on the requesting user's runs only; another user's run SHALL respond 404. `POST /api/modules/brain/runs/now` SHALL run the nightly pass for the requesting user's brain only, and SHALL respond 409 while a pass for that user is running. The `Nightly` tab's `Run it now` SHALL use it, so every user can start a pass for their own brain.

#### Scenario: Member runs their own pass
- **WHEN** member `Sanne` chooses `Run it now` on the Nightly tab
- **THEN** a pass runs for her brain only, and the owner's brain is untouched

## MODIFIED Requirements

### Requirement: A nightly job maintains the brain

The `brain` module SHALL schedule a job `nightly` (job id `brain/nightly`) with the cron expression from `BRAIN_NIGHTLY_CRON` (default `0 3 * * *`). When the value is `off`, the job SHALL NOT be scheduled. For each user (as specified in "The nightly pass runs per user"), a run SHALL extract notes from that user's conversations first, consolidate that user's pages second, and generate that user's profile summary third. Each user's run SHALL be recorded in that user's brain with its trigger, times, outcome (`ok`, `partial` or `failed`), counts (conversations handled and skipped, notes added, pages rewritten, pages created, merges), whether the summary was generated, dropped lines, merges, the range of revisions it wrote, and any error. The job SHALL return a summary with the counts summed over all users, and no content. The run SHALL stop at the next conversation or model call when its signal is aborted.

#### Scenario: Scheduled run
- **WHEN** `BRAIN_NIGHTLY_CRON` is unset
- **THEN** `brain/nightly` is scheduled for 03:00 in `FRIDAY_TIMEZONE`

#### Scenario: Disabled
- **WHEN** `BRAIN_NIGHTLY_CRON=off` and the module is loaded
- **THEN** no `brain/nightly` job is registered

#### Scenario: Summary
- **WHEN** a run handles 5 conversations, 2 of them trivial, adds 4 notes, rewrites 3 pages with 1 merge, and generates the profile summary
- **THEN** the job's summary states those counts and that the summary was generated, and that user's brain records the run with the revisions it wrote
