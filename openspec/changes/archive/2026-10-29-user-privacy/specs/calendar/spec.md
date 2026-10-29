## ADDED Requirements

### Requirement: The calendar is the owner's

Until users have their own calendar connections, the calendar module's data SHALL be available to the household owner only:
- every calendar tool SHALL be declared owner-only (as specified in `data-ownership`);
- its agenda prompt context SHALL render only for the owner;
- its portal routes SHALL respond 403 to anyone but the owner, and the Calendar page SHALL show that the calendar is the owner's.

#### Scenario: Member's prompt
- **WHEN** a chat turn starts for member `Sanne`
- **THEN** her prompt holds no agenda and her turn offers no calendar tools

#### Scenario: Member opens the Calendar page
- **WHEN** member `Sanne` opens `/m/calendar`
- **THEN** the page says the calendar belongs to the household owner, and no agenda is loaded
