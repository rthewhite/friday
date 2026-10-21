# Spec Delta

## MODIFIED Requirements

### Requirement: Change log and undo

Every change Friday makes to the calendar (create, confirmed edit, confirmed deletion, undo) SHALL be logged with its time, action, scope, the event's title and times, its state before and after (enough to restore it), and its source: the channel (`voice`, `chat`, `agent` or `portal`) and, when known, the conversation id. The log SHALL keep the most recent 500 entries. `calendar_undo` SHALL be offered on voice, chat and agent, take no parameters, and revert the most recent create, edit or deletion made through a tool in the last 24 hours that has not been undone. On voice and chat it SHALL consider only changes made on voice or chat, and in an agent run only changes made by agents, so neither reverts the other's work. Undoing a create SHALL delete the event, undoing an edit SHALL restore the previous version, and undoing a deletion SHALL recreate the event (the series, for a deleted series, or the occurrence, for a deleted occurrence). An undo SHALL NOT need confirmation. It SHALL itself be logged, and it SHALL NOT be a target of a later undo. When the event changed in iCloud after Friday's change, the undo SHALL refuse and return the current version. The result SHALL describe what was reverted.

#### Scenario: Undo a deletion
- **WHEN** the user confirmed deleting "Dentist" and then says "undo that"
- **THEN** `calendar_undo` recreates "Dentist" as it was and says so

#### Scenario: Nothing to undo
- **WHEN** no tool change was made in the last 24 hours, or all of them were undone
- **THEN** `calendar_undo` reports that there is nothing to undo

#### Scenario: Changed since
- **WHEN** Friday moved an event and the user then edited it on their phone
- **THEN** undoing Friday's move is refused and the current version is returned

#### Scenario: An agent's change is not undone by voice
- **WHEN** an agent created "Gym" after the user created "Dentist" by voice, and the user then says "undo that"
- **THEN** `calendar_undo` deletes "Dentist", and "Gym" stays

#### Scenario: An agent undoes only agent changes
- **WHEN** the user created "Dentist" by voice and an agent run then calls `calendar_undo`
- **THEN** it reports that there is nothing to undo, and "Dentist" stays
