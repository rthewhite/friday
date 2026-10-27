## ADDED Requirements

### Requirement: Revisions made in the portal record the user

A revision with author `user` written through the brain's routes SHALL record the id and name of the user who made it, taken from the request. Revisions written by tools, extraction, consolidation and the system, and revisions written before users existed, SHALL have no user. The page history in the portal SHALL show the user's name next to the author `user` when it is recorded. The brain SHALL NOT be filtered by user. Every user sees and edits the same brain.

#### Scenario: Edit in the portal
- **WHEN** member `Sanne` saves a page in the portal
- **THEN** the new revision has author `user` and records `Sanne`, and the history shows `Sanne`

#### Scenario: Remembered by a tool
- **WHEN** `brain_remember` appends a note during a chat turn of `Sanne`
- **THEN** the revision has author `remember` and no user
