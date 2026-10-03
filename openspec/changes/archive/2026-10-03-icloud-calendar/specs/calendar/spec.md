# Calendar

## Purpose

Gives Friday the user's iCloud calendar: it knows today's and tomorrow's agenda, answers questions about events, and creates, edits and deletes events on request, with a confirmation step for changes and deletions, an undo, and a portal page that shows what Friday sees and what it changed.

## ADDED Requirements

### Requirement: Calendar module and credentials

An in-process module with id `calendar` SHALL connect to one iCloud account over CalDAV. It SHALL declare `ICLOUD_USERNAME` (the Apple ID email, plain) and `ICLOUD_APP_PASSWORD` (an app-specific password, secret) as required config keys, so it fails to load, with an error naming the missing key, when either is unset. Both SHALL be read for every request, so values saved later are used from the next request on without a reload. When iCloud rejects the credentials (HTTP 401), the error SHALL name the username and explain that `ICLOUD_APP_PASSWORD` must be an app-specific password, created at account.apple.com under Sign-In and Security, App-Specific Passwords, and that it may have been revoked. The password SHALL NOT appear in logs, tool results, route responses or error messages. The module SHALL ship a portal UI (`ui: true`).

#### Scenario: Keys not configured
- **WHEN** the module loads without `ICLOUD_APP_PASSWORD`
- **THEN** the module fails with an error naming `ICLOUD_APP_PASSWORD` and registers no tools

#### Scenario: Rejected password
- **WHEN** iCloud answers a request with HTTP 401
- **THEN** the tool error names the username, says an app-specific password is required and where to create one, and contains no part of the password

#### Scenario: Password replaced
- **WHEN** a request failed with HTTP 401 and the user then saves a new `ICLOUD_APP_PASSWORD`
- **THEN** the next request uses the new password without reloading the module

### Requirement: Calendar discovery

The module SHALL discover the account's calendars from iCloud rather than from configuration, and SHALL include only collections that hold events (reminder lists are excluded). For each calendar it SHALL know a stable id, its display name, its colour when iCloud reports one, and whether the account may write to it. Discovery SHALL be repeated with every agenda refresh, so a calendar added or shared with the user later appears without a reload and a removed one disappears.

#### Scenario: Shared calendar appears
- **WHEN** a calendar is shared with the account and the next agenda refresh runs
- **THEN** the calendar is listed in the portal and its events are available to the tools

#### Scenario: Reminder list excluded
- **WHEN** the account has a reminder list that supports only tasks
- **THEN** it is not listed as a calendar

### Requirement: Calendar settings

Each discovered calendar SHALL have two settings, `use` (Friday reads and writes it) and `inAgenda` (its events appear in the prompt agenda), both on by default for a newly discovered calendar, and the account SHALL have at most one default calendar for new events. Settings SHALL be stored by the module, survive restarts, and be changed only through the portal. A calendar that is not used SHALL be invisible to every tool, the agenda and overlap checks. When no default is set, or the default is not used or not writable, new events SHALL go to the first used, writable calendar in the order iCloud lists them.

#### Scenario: Unused calendar hidden
- **WHEN** `use` is off for "Work" and `calendar_list_events` covers a day with a Work event
- **THEN** the Work event is not returned

#### Scenario: Default calendar
- **WHEN** "Home" is the default and `calendar_create_event` is called without a calendar
- **THEN** the event is created in Home

#### Scenario: No usable default
- **WHEN** the default calendar is set to unused
- **THEN** new events without a calendar go to the first used, writable calendar

### Requirement: Event times and identity

Every event a tool returns SHALL carry an `id`, `title`, `calendar` (name), `start`, `end`, `allDay`, `when`, `recurring`, `readOnly`, and `location` and `notes` when present (notes cut to 500 characters). Timed events SHALL give `start` and `end` as ISO 8601 date-times with the offset of `FRIDAY_TIMEZONE` at that moment. All-day events SHALL give dates (`YYYY-MM-DD`), with `end` as the last day of the event, inclusive. `when` SHALL be a short readable phrase in the household zone (for example `Thu 8 Oct, 15:00-16:00` or `Thu 8 Oct, all day`). Times given to a tool SHALL be ISO 8601 date-times, read in `FRIDAY_TIMEZONE` when they carry no offset, or dates (`YYYY-MM-DD`) where a parameter allows them. A value that is neither SHALL be an error naming the parameter. An `id` SHALL identify one event, and one occurrence for a recurring event. It SHALL stay valid for at least two hours after the event was last returned, and an unknown or expired `id` SHALL be an error asking to list the events again. Edits and deletions SHALL accept only an `id`, never a title or description.

#### Scenario: Offset-less input
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` and a tool is given `2026-10-08T15:00`
- **THEN** it is read as 15:00 Amsterdam time (`+02:00` on that date)

#### Scenario: All-day event
- **WHEN** a two-day all-day event covers 8 and 9 October
- **THEN** it is returned with `allDay: true`, `start: "2026-10-08"` and `end: "2026-10-09"`

#### Scenario: Stale id
- **WHEN** `calendar_delete_event` is called with an id that was never returned or has expired
- **THEN** the call fails, asking to list the events again, and nothing changes

### Requirement: Listing events

`calendar_list_events` SHALL be offered on voice and chat and SHALL take optional `from` and `to` (date-times or dates, where a `to` date includes that whole day), an optional `query` and an optional `calendar` name. Without `from` it SHALL start at the beginning of today in `FRIDAY_TIMEZONE`. Without `to` it SHALL cover 7 days, or 365 days when a `query` is given. `to` SHALL be after `from`, and the range SHALL NOT exceed 366 days. Recurring events SHALL be expanded into the occurrences inside the range, honouring exceptions and moved occurrences. A `query` SHALL match an event when every word in it appears, case-insensitively, in the title, location or notes. Events SHALL be returned sorted by start, at most 50, with `truncated: true` and the total count when there were more. An unknown `calendar` name SHALL be an error listing the used calendars.

#### Scenario: Today's events
- **WHEN** called with `from` and `to` both set to today's date
- **THEN** it returns every event in a used calendar that overlaps today, including each occurrence of a recurring event and all-day events

#### Scenario: Search ahead
- **WHEN** called with `query: "dentist"` and no range
- **THEN** it returns events from today through the next 365 days whose title, location or notes contain "dentist"

#### Scenario: Moved occurrence
- **WHEN** one occurrence of a weekly event was moved from Tuesday to Wednesday
- **THEN** that week lists it on Wednesday only

#### Scenario: Range too long
- **WHEN** `from` and `to` are 400 days apart
- **THEN** the call fails, saying the range can be at most 366 days

### Requirement: Creating events

`calendar_create_event` SHALL be offered on voice and chat and SHALL take a required `title` and `start`, and optionally `end`, `allDay`, `location`, `notes`, `calendar` (name), `repeat` (`daily`, `weekly`, `monthly` or `yearly`) and `repeatUntil` (a date). Without `end`, a timed event SHALL last one hour and an all-day event one day. An all-day event SHALL take dates, with `end` as its last day, inclusive. `end` SHALL NOT be before `start`. The event SHALL be created immediately, in the given calendar or the default, and its times SHALL be stored in `FRIDAY_TIMEZONE`. The result SHALL contain the created event (with its `id`) and `overlaps`: the timed events in used calendars that overlap it. A calendar that is unknown, not used or not writable SHALL be an error, and nothing is created.

#### Scenario: Simple create
- **WHEN** called with `title: "Plumber"` and `start: "2026-10-13T09:00"`
- **THEN** a one-hour event is created in the default calendar and returned with its `when` text

#### Scenario: Clash reported
- **WHEN** the new event overlaps an existing "Dentist" event
- **THEN** the result lists "Dentist" under `overlaps` and the event is still created

#### Scenario: Weekly event
- **WHEN** called with `repeat: "weekly"` and `repeatUntil: "2026-12-31"`
- **THEN** the event repeats every week on the start's weekday until that date

#### Scenario: Read-only calendar
- **WHEN** called with a calendar the account cannot write to
- **THEN** the call fails, saying that calendar is read-only, and nothing is created

### Requirement: Previewing edits and deletions

`calendar_update_event` and `calendar_delete_event` SHALL be offered on voice and chat and SHALL NOT change the calendar. `calendar_update_event` SHALL take an `id` and at least one of `title`, `start`, `end`, `location` and `notes`. A new `start` without an `end` SHALL keep the event's duration, and an empty `location` or `notes` SHALL clear it. `calendar_delete_event` SHALL take an `id`. For a recurring event both SHALL require `scope`, either `occurrence` (only the identified occurrence) or `series` (every occurrence), and a missing scope SHALL be an error that asks which one is meant. A series edit SHALL change the time of day of every occurrence by the same shift as the identified occurrence, and SHALL refuse a change of date. Both tools SHALL return `token`, `expiresInSeconds`, `action`, `before` and, for an edit, `after` and `overlaps`, and an instruction to read the change back to the user and call `calendar_confirm` only after they agree. A token SHALL expire 5 minutes after it was issued.

#### Scenario: Edit previewed
- **WHEN** `calendar_update_event` moves "Dentist" from 14:00 to 15:00
- **THEN** the result shows before 14:00 and after 15:00 with a token, and the event in iCloud is still at 14:00

#### Scenario: Recurring without scope
- **WHEN** `calendar_delete_event` is called for an occurrence of a weekly event without `scope`
- **THEN** the call fails, asking whether to delete only this occurrence or the whole series

#### Scenario: Series moved to a later time
- **WHEN** a weekly 09:00 event is updated with `scope: "series"` and a new start at 10:00 on the same day
- **THEN** the preview shows every occurrence moving to 10:00 with its duration kept

#### Scenario: Series date change refused
- **WHEN** a weekly event is updated with `scope: "series"` and a start on a different day
- **THEN** the call fails, saying a series can only be moved to another time of day by Friday

### Requirement: Confirming a change

`calendar_confirm` SHALL be offered on voice and chat and SHALL take a `token`. It SHALL apply exactly the change that was previewed with that token. A token SHALL be usable once, and a used, expired or unknown token SHALL be an error that applies nothing and asks to preview the change again. When the event was changed or deleted in iCloud after the preview, nothing SHALL be applied and the error SHALL include the event's current version, if it still exists. Deleting one occurrence SHALL remove only that occurrence from the series. Editing one occurrence SHALL change only that occurrence. The result SHALL describe what was done.

#### Scenario: Confirmed edit
- **WHEN** `calendar_confirm` is called with a fresh token from an edit preview
- **THEN** the event is changed in iCloud as previewed and the result shows the new event

#### Scenario: Token reused
- **WHEN** a token that was already confirmed is passed again
- **THEN** the call fails and nothing changes

#### Scenario: Changed on the phone meanwhile
- **WHEN** the event was edited on the user's phone between the preview and the confirm
- **THEN** nothing is applied and the error shows the event as it is now

#### Scenario: One occurrence deleted
- **WHEN** the deletion of one occurrence of a weekly event is confirmed
- **THEN** that occurrence no longer appears and the other occurrences remain

### Requirement: Invitations and read-only events

An event in a calendar the account cannot write to, or one whose organizer is not the account itself (an invitation), SHALL be returned with `readOnly: true` and a short reason. `calendar_update_event` and `calendar_delete_event` SHALL refuse such an event with that reason before issuing a token.

#### Scenario: Invitation
- **WHEN** `calendar_delete_event` is called for a meeting organized by someone else
- **THEN** the call fails, saying it is an invitation to change in the Calendar app, and no token is issued

### Requirement: Change log and undo

Every change Friday makes to the calendar (create, confirmed edit, confirmed deletion, undo) SHALL be logged with its time, action, scope, the event's title and times, its state before and after (enough to restore it), and its source: the channel (`voice`, `chat` or `portal`) and, when known, the conversation id. The log SHALL keep the most recent 500 entries. `calendar_undo` SHALL be offered on voice and chat, take no parameters, and revert the most recent create, edit or deletion made through a tool in the last 24 hours that has not been undone. Undoing a create SHALL delete the event, undoing an edit SHALL restore the previous version, and undoing a deletion SHALL recreate the event (the series, for a deleted series, or the occurrence, for a deleted occurrence). An undo SHALL NOT need confirmation. It SHALL itself be logged, and it SHALL NOT be a target of a later undo. When the event changed in iCloud after Friday's change, the undo SHALL refuse and return the current version. The result SHALL describe what was reverted.

#### Scenario: Undo a deletion
- **WHEN** the user confirmed deleting "Dentist" and then says "undo that"
- **THEN** `calendar_undo` recreates "Dentist" as it was and says so

#### Scenario: Nothing to undo
- **WHEN** no tool change was made in the last 24 hours, or all of them were undone
- **THEN** `calendar_undo` reports that there is nothing to undo

#### Scenario: Changed since
- **WHEN** Friday moved an event and the user then edited it on their phone
- **THEN** undoing Friday's move is refused and the current version is returned

### Requirement: Agenda in the prompt

The module SHALL add a calendar section to the voice and chat prompts listing the events of today and tomorrow, in used calendars with `inAgenda` on, in `FRIDAY_TIMEZONE`. Each day SHALL be labelled with its weekday and date, all-day events first, then timed events by start with their time range, title and location. A day without events SHALL say so. "Today" and "tomorrow" SHALL be worked out when the prompt is built, not when the events were fetched. The events SHALL come from a cache that a background job refreshes every 5 minutes, and that is also refreshed after each change Friday makes. Building the prompt SHALL NOT wait on iCloud. When the cache is older than 15 minutes the section SHALL say when it was fetched. When no refresh has succeeded since the module loaded, the section SHALL say the calendar is unavailable right now. The section SHALL be cut to 2000 characters, ending with how many events were left out.

#### Scenario: Agenda present
- **WHEN** today has a 10:00-11:00 "Swimming lesson" and tomorrow is empty
- **THEN** the prompt's calendar section lists the lesson under today and says tomorrow has nothing planned

#### Scenario: Midnight rollover
- **WHEN** the cache was fetched at 23:58 and a prompt is built at 00:01
- **THEN** the section labels the new day as today

#### Scenario: iCloud unreachable
- **WHEN** refreshes have failed for 20 minutes after an earlier success
- **THEN** the section still lists the cached events and says when they were fetched

#### Scenario: Never fetched
- **WHEN** iCloud has been unreachable since the module loaded
- **THEN** the section says the calendar is unavailable right now

### Requirement: Portal routes

The module SHALL serve, under `/api/modules/calendar/`:
- `GET status`: the username, whether the last request to iCloud succeeded, when it was checked, the last error (never containing the password), and the calendars with `id`, `name`, `color`, `writable`, `use`, `inAgenda` and `default`.
- `PUT settings`: `use` and `inAgenda` per calendar id, and the default calendar id. It SHALL reject unknown ids and a default that is not used or not writable with HTTP 400.
- `GET agenda`: the exact calendar section text the prompt gets now, and when it was fetched.
- `GET changes`: log entries, newest first (`limit`, default 50, at most 200), each with its source, action, scope, title, before and after summary, and whether it was undone and whether it can still be undone.
- `POST changes/:id/undo`: undo that entry with the same rules as `calendar_undo` except the 24-hour limit, logged with source `portal`. An entry that cannot be undone SHALL answer HTTP 409 with the reason and, when the event changed since, its current version.
- `POST refresh`: rediscover calendars and refresh the agenda, then answer as `GET status`.

#### Scenario: Default must be writable
- **WHEN** `PUT settings` names a read-only calendar as the default
- **THEN** the response is HTTP 400 and the settings are unchanged

#### Scenario: Undo from the portal
- **WHEN** `POST changes/:id/undo` is called for an edit made two days ago and the event is unchanged since
- **THEN** the previous version is restored and a new log entry with source `portal` is added

### Requirement: Calendar portal page

The module UI SHALL add a "Calendar" entry to the portal navigation, with a page at `/m/calendar` that has two tabs. **Overview** SHALL show the connection status (username, connected or the last error, last checked) with a refresh button; the calendars, each with its colour, a read-only badge when not writable, and controls for `use`, `inAgenda` and the default for new events; and the agenda text exactly as Friday currently gets it. **Changes** SHALL list the change log (time, source, action, title, before and after) with an Undo button on each entry that can still be undone. The page SHALL NOT show an event grid or offer event editing.

#### Scenario: Settings saved
- **WHEN** the user turns off "in agenda" for Work on the Overview tab
- **THEN** the setting is saved and the agenda preview no longer shows Work events after the next refresh

#### Scenario: Undo from Changes
- **WHEN** the user clicks Undo on a change that can still be undone
- **THEN** the change is reverted, the list shows it as undone, and a new entry appears
