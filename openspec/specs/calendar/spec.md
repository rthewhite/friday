# Calendar

## Purpose

Gives Friday the user's iCloud calendar and a read-only copy of their Work (Outlook) calendar from the homelab intake. With them it knows today's and tomorrow's agenda, answers questions about events and spots clashes with work meetings. It also creates, edits and deletes iCloud events on request, with a confirmation step for changes and deletions and an undo. A portal page shows what Friday sees and what it changed.

## Requirements

### Requirement: Calendar module and credentials

An in-process module with id `calendar` SHALL read the user's calendars from two optional sources. The first is one iCloud account over CalDAV, configured by `ICLOUD_USERNAME` (the Apple ID email, plain) and `ICLOUD_APP_PASSWORD` (an app-specific password, secret). The second is the work calendar from the intake service, configured by `INTAKE_URL` (plain) and `INTAKE_KEY` (secret). A source is configured when both of its keys are set. The module SHALL fail to load when neither source is configured at load time, with an error naming the missing keys. All keys SHALL be read for every request and poll, so values saved later are used from the next request on without a reload. A source with only one of its keys set SHALL report the missing key in the portal status and add no calendars. When iCloud rejects the credentials (HTTP 401), the error SHALL name the username and explain three things: `ICLOUD_APP_PASSWORD` must be an app-specific password, it is created at account.apple.com under Sign-In and Security, App-Specific Passwords, and it may have been revoked. Neither the password nor `INTAKE_KEY` SHALL appear in logs, tool results, route responses or error messages. The module SHALL ship a portal UI (`ui: true`).

#### Scenario: Keys not configured
- **WHEN** the module loads with neither `ICLOUD_APP_PASSWORD` nor `INTAKE_KEY` set
- **THEN** the module fails with an error naming the missing keys and registers no tools

#### Scenario: Work calendar only
- **WHEN** the module loads with `INTAKE_URL` and `INTAKE_KEY` set and no iCloud keys
- **THEN** the module loads, its tools are registered, and only the Work calendar is listed

#### Scenario: Rejected password
- **WHEN** iCloud answers a request with HTTP 401
- **THEN** the tool error names the username, says an app-specific password is required and where to create one, and contains no part of the password

#### Scenario: Password replaced
- **WHEN** a request failed with HTTP 401 and the user then saves a new `ICLOUD_APP_PASSWORD`
- **THEN** the next request uses the new password without reloading the module

### Requirement: Calendar discovery

When iCloud is configured, the module SHALL discover the account's calendars from iCloud rather than from configuration. It SHALL include only collections that hold events, so reminder lists are excluded. For each calendar it SHALL know a stable id, its display name, its colour when iCloud reports one, and whether the account may write to it. Discovery SHALL be repeated with every agenda refresh, so a calendar added or shared with the user later appears without a reload and a removed one disappears. When the intake is configured, the calendars SHALL also include one read-only calendar named `Work`, after the iCloud calendars, whether or not a snapshot has been received yet. When an iCloud calendar is also called `Work` (any case), the intake calendar SHALL be named `Work (Outlook)`. When iCloud can't be reached, the Work calendar SHALL still be listed and used.

#### Scenario: Shared calendar appears
- **WHEN** a calendar is shared with the account and the next agenda refresh runs
- **THEN** the calendar is listed in the portal and its events are available to the tools

#### Scenario: Reminder list excluded
- **WHEN** the account has a reminder list that supports only tasks
- **THEN** it is not listed as a calendar

#### Scenario: Work calendar listed
- **WHEN** the intake is configured and iCloud lists "Home" and "Family"
- **THEN** the calendars are "Home", "Family" and "Work", and "Work" is not writable

#### Scenario: Name clash
- **WHEN** the intake is configured and iCloud also has a calendar called "Work"
- **THEN** the intake calendar is listed as "Work (Outlook)"

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

Every event a tool returns SHALL carry a `title` and a `when`. It SHALL carry an `id` only when Friday can change the event (see "Invitations and read-only events"), `recurring: true` only when it is an occurrence of a recurring event, and `location`, `notes` (cut to 200 characters) and `status` (`tentative`, `free`, `cancelled` or `out of office`) only when present. It SHALL NOT carry `start`, `end`, `allDay` or `readOnly` flags. A result that holds a single event (a created or confirmed event) SHALL also give that event's `calendar` name; a list names calendars as described under "Listing events". `when` SHALL be a short readable phrase in `FRIDAY_TIMEZONE` that fully determines the event's days and times: the weekday, day and month; the year when it is not the current year in `FRIDAY_TIMEZONE`; and the time range, or `all day`. For example `Thu 8 Oct, 15:00-16:00`, `Thu 8 Oct - Fri 9 Oct, all day` or `Thu 8 Oct 22:00 - Fri 9 Oct 01:00`. Times given to a tool SHALL be ISO 8601 date-times, read in `FRIDAY_TIMEZONE` when they carry no offset, or dates (`YYYY-MM-DD`) where a parameter allows them. A value that is neither SHALL be an error naming the parameter. An `id` SHALL identify one event, and one occurrence for a recurring event. It SHALL stay valid for at least two hours after the event was last returned. An unknown or expired `id` SHALL be an error asking to list the events again. Edits and deletions SHALL accept only an `id`, never a title or description.

#### Scenario: Offset-less input
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` and a tool is given `2026-10-08T15:00`
- **THEN** it is read as 15:00 Amsterdam time (`+02:00` on that date)

#### Scenario: All-day event
- **WHEN** a two-day all-day event covers 8 and 9 October 2026 and it is 2026
- **THEN** it is returned with `when: "Thu 8 Oct - Fri 9 Oct, all day"` and without `start`, `end` or `allDay`

#### Scenario: Next year
- **WHEN** it is October 2026 and an event on 9 March 2027 from 14:00 to 15:00 is returned
- **THEN** its `when` is `Tue 9 Mar 2027, 14:00-15:00`

#### Scenario: Editable recurring occurrence
- **WHEN** an occurrence of a weekly event in a writable iCloud calendar is listed
- **THEN** it carries an `id` and `recurring: true`

#### Scenario: Stale id
- **WHEN** `calendar_delete_event` is called with an id that was never returned or has expired
- **THEN** the call fails, asking to list the events again, and nothing changes

#### Scenario: Tentative meeting
- **WHEN** a work meeting has `showAs: "tentative"`
- **THEN** it is returned with `status: "tentative"`

### Requirement: Listing events

`calendar_list_events` SHALL be offered on voice and chat. It SHALL take optional `from` and `to` (date-times or dates, where a `to` date includes that whole day), an optional `query` and an optional `calendar` name. Its description SHALL tell the model to pass `from` and `to` for the days the user asked about, and to pass a `to` that covers the period for open questions such as what is coming up. Without `from` it SHALL start at the beginning of today in `FRIDAY_TIMEZONE`. Without `to` it SHALL end at the end of the day `from` falls on in `FRIDAY_TIMEZONE`, or cover 365 days when a `query` is given. `to` SHALL be after `from`, and the range SHALL NOT exceed 366 days. Recurring events SHALL be expanded into the occurrences inside the range, honouring exceptions and moved occurrences. A `query` SHALL match an event when every word in it appears, case-insensitively, in the title, location or notes. Events SHALL be returned under `events`, sorted by start, at most 50, with `truncated: true` and the total count when there were more. The result SHALL say which days it searched as `covers`: one day like `Sun 4 Oct`, or a range like `Mon 5 Oct - Sun 11 Oct`, with the year for a day outside the current year. This way an empty result is not read as free time beyond those days. When every returned event is in the same calendar (the same calendar, not just the same name), the result SHALL name that calendar once as `calendar` and the events SHALL NOT carry it. Otherwise each event SHALL carry its `calendar` name. When returned events are in a calendar Friday can't change (the Work calendar, or a calendar the account cannot write to), the result SHALL include `readOnly`, an object that maps each such calendar's name to its reason, once per calendar. An unknown `calendar` name SHALL be an error listing the used calendars. When the Work calendar is among the calendars listed, the result SHALL include a `coverage` note in two cases: when no snapshot has been received yet, or when the range reaches outside the snapshot's window (one calendar month before its `received_at` to six calendar months after it, in `FRIDAY_TIMEZONE`). The note SHALL say which dates the Work calendar covers, so that the absence of work events outside that window is not read as free time. When iCloud can't be reached, the Work calendar's events SHALL still be returned, with a note that the iCloud calendars could not be read. When the Work calendar is the only calendar listed, an iCloud failure SHALL NOT matter.

#### Scenario: Today's events
- **WHEN** called with `from` and `to` both set to today's date
- **THEN** it returns every event in a used calendar that overlaps today, including each occurrence of a recurring event and all-day events

#### Scenario: No range
- **WHEN** called without `from`, `to` or `query`
- **THEN** it returns only the events that overlap today, with `covers` naming today

#### Scenario: Nothing found
- **WHEN** Sunday 4 October has no events and the call asks for that day
- **THEN** the result is `covers: "Sun 4 Oct"` with no events and no `calendar`

#### Scenario: Calendars sharing a name
- **WHEN** a day has events in two different calendars that are both called "Family"
- **THEN** the result has no top-level `calendar`, and each event names its calendar

#### Scenario: One named day
- **WHEN** it is Saturday 10 October 2026 and the call has `from: "2026-10-12"` and no `to`
- **THEN** it returns only the events that overlap Monday 12 October

#### Scenario: Rest of the day
- **WHEN** called with `from: "2026-10-12T15:00"` and no `to`
- **THEN** it returns the events that overlap 15:00 to midnight on 12 October

#### Scenario: Search ahead
- **WHEN** called with `query: "dentist"` and no range
- **THEN** it returns events from today through the next 365 days whose title, location or notes contain "dentist"

#### Scenario: Only work meetings
- **WHEN** a day has three meetings, all in the Work calendar
- **THEN** the result has `calendar: "Work"`, events without `calendar` or `id`, and `readOnly` mapping `Work` to a reason saying the events come from Outlook and must be changed there

#### Scenario: Home and work together
- **WHEN** a day has "Swimming lesson" in Home and "MASH Standup" in Work
- **THEN** the result has no top-level `calendar`, each event names its calendar, "Swimming lesson" has an `id`, and `readOnly` names only `Work`

#### Scenario: Moved occurrence
- **WHEN** one occurrence of a weekly event was moved from Tuesday to Wednesday
- **THEN** that week lists it on Wednesday only

#### Scenario: Range too long
- **WHEN** `from` and `to` are 400 days apart
- **THEN** the call fails, saying the range can be at most 366 days

#### Scenario: Search past the work window
- **WHEN** the snapshot was received on 10 October 2026 and `calendar_list_events` is called with `query: "standup"` and no range
- **THEN** the result includes a `coverage` note saying the Work calendar covers 10 September 2026 to 10 April 2027

#### Scenario: iCloud down
- **WHEN** iCloud can't be reached and today has two work meetings
- **THEN** `calendar_list_events` for today returns the two work meetings and notes that the iCloud calendars could not be read

### Requirement: Creating events

`calendar_create_event` SHALL be offered on voice and chat. It SHALL take a required `title` and `start`, and optionally `end`, `allDay`, `location`, `notes`, `calendar` (name), `repeat` (`daily`, `weekly`, `monthly` or `yearly`) and `repeatUntil` (a date). Without `end`, a timed event SHALL last one hour and an all-day event one day. An all-day event SHALL take dates, with `end` as its last day, inclusive. `end` SHALL NOT be before `start`. The event SHALL be created immediately, in the given calendar or the default, with its times stored in `FRIDAY_TIMEZONE`. The result SHALL contain the created event (with its `id`) and `overlaps`: the timed events in used calendars that overlap it, including work meetings. Events with the status `free` or `cancelled` SHALL NOT count as overlaps. A calendar that is unknown, not used or not writable SHALL be an error, and nothing is created.

#### Scenario: Simple create
- **WHEN** called with `title: "Plumber"` and `start: "2026-10-13T09:00"`
- **THEN** a one-hour event is created in the default calendar and returned with its `when` text

#### Scenario: Clash reported
- **WHEN** the new event overlaps an existing "Dentist" event
- **THEN** the result lists "Dentist" under `overlaps` and the event is still created

#### Scenario: Work meeting clash
- **WHEN** the new event overlaps a busy meeting in the Work calendar
- **THEN** the result lists that meeting under `overlaps`

#### Scenario: Cancelled meeting ignored
- **WHEN** the new event overlaps only a cancelled work meeting
- **THEN** `overlaps` is empty

#### Scenario: Weekly event
- **WHEN** called with `repeat: "weekly"` and `repeatUntil: "2026-12-31"`
- **THEN** the event repeats every week on the start's weekday until that date

#### Scenario: Read-only calendar
- **WHEN** called with a calendar the account cannot write to, or with the Work calendar
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

Friday SHALL NOT be able to change these events:
- an event in a calendar the account cannot write to;
- an invitation, meaning an event whose organizer is not the account itself;
- an event in the Work calendar.

Such an event SHALL be returned without an `id`. For an invitation, the event itself SHALL carry `readOnly` with a short reason saying who it is from and that it is changed or declined in the Calendar app. For the other two, the reason SHALL be given per calendar, as described under "Listing events". The Work calendar's reason SHALL say that its events come from Outlook and must be changed there. `calendar_update_event` and `calendar_delete_event` SHALL refuse such an event with that reason before issuing a token, for an id issued while the event could still be changed. For a Work event they SHALL refuse without contacting iCloud.

#### Scenario: Invitation
- **WHEN** `calendar_delete_event` is called with an id that resolves to a meeting organized by someone else
- **THEN** the call fails, saying it is an invitation to change in the Calendar app, and no token is issued

#### Scenario: Work meeting
- **WHEN** `calendar_update_event` is called with an id that resolves to an event in the Work calendar
- **THEN** the call fails, saying it comes from Outlook and must be changed there, and no token is issued

#### Scenario: Invitation listed
- **WHEN** a meeting organized by someone else is listed
- **THEN** it has no `id`, and its `readOnly` says it is an invitation from that organizer to change or decline in the Calendar app

#### Scenario: Read-only calendar listed
- **WHEN** an event in a subscribed holiday calendar is listed
- **THEN** it has no `id`, and the result's `readOnly` maps that calendar's name to a reason saying it is read-only

#### Scenario: Calendar became read-only
- **WHEN** an event was listed with an id and its calendar can no longer be written to when `calendar_delete_event` is called
- **THEN** the call fails, saying the calendar is read-only, and no token is issued

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

### Requirement: Agenda in the prompt

The module SHALL add a calendar section to the voice and chat prompts listing the events of today and tomorrow. It SHALL include the events in used calendars with `inAgenda` on, in `FRIDAY_TIMEZONE`. Each day SHALL be labelled with its weekday, its date with the year, and its ISO date (`YYYY-MM-DD`). The section SHALL also have one line giving the weekday and ISO date of each of the seven days after tomorrow, so that day names can be turned into dates. That line SHALL be present whenever the section is, including when no source is available, and SHALL NOT be dropped by the cut. When no source is available there are no day headings, so the section SHALL then say today's weekday, date and ISO date. All-day events SHALL come first, then timed events by start, each with its time range, title and location. An event's status SHALL follow in brackets, for example `(tentative)`. When more than one calendar is in the agenda, the event's calendar name SHALL follow too. A day without events SHALL say so. "Today", "tomorrow" and the following days SHALL be worked out when the prompt is built, not when the events were fetched. The iCloud events SHALL come from a cache that a background job refreshes every 5 minutes, and that is also refreshed after each change Friday makes. The Work events SHALL come from the stored snapshot. Building the prompt SHALL NOT wait on iCloud or the intake. Each configured source SHALL get its own notes:
- iCloud, when no refresh has succeeded since the module loaded: the iCloud calendars are unavailable right now;
- iCloud, when its cache is older than 15 minutes: when it was fetched;
- Work, when no snapshot has been received: the work calendar is unavailable right now;
- Work, when the snapshot's `received_at` is more than 3 hours old: when the work calendar was last updated.

A source that is not configured SHALL NOT be mentioned. The section SHALL be cut to 2000 characters, ending with how many events were left out.

#### Scenario: Agenda present
- **WHEN** today has a 10:00-11:00 "Swimming lesson" and tomorrow is empty
- **THEN** the prompt's calendar section lists the lesson under today and says tomorrow has nothing planned

#### Scenario: Dates for day names
- **WHEN** a prompt is built on Saturday 10 October 2026
- **THEN** the section labels today `Saturday 10 October 2026 (2026-10-10)`, and its coming-days line runs from `Mon 2026-10-12` to `Sun 2026-10-18`

#### Scenario: Midnight rollover
- **WHEN** the cache was fetched at 23:58 and a prompt is built at 00:01
- **THEN** the section labels the new day as today, and the coming-days line starts one day later

#### Scenario: iCloud unreachable
- **WHEN** refreshes have failed for 20 minutes after an earlier success
- **THEN** the section still lists the cached events and says when they were fetched

#### Scenario: Never fetched
- **WHEN** iCloud has been unreachable since the module loaded
- **THEN** the section says the iCloud calendars are unavailable right now, and still lists the Work events

#### Scenario: Nothing available
- **WHEN** no source has any events available
- **THEN** the section still says today's date and has the coming-days line, next to the unavailable notes

#### Scenario: Work and home together
- **WHEN** today has "Swimming lesson" in Home and a tentative "MASH Standup" online in Work
- **THEN** the section lists `Swimming lesson` followed by `[Home]`, and `MASH Standup` followed by `(online)`, `(tentative)` and `[Work]`

#### Scenario: Work snapshot old
- **WHEN** the last snapshot was received 5 hours ago
- **THEN** the section still lists its events for today and says when the work calendar was last updated

#### Scenario: Intake not configured
- **WHEN** only iCloud is configured
- **THEN** the section does not mention a work calendar

### Requirement: Portal routes

The module SHALL serve, under `/api/modules/calendar/`:
- `GET status`:
  - whether iCloud is configured, the username, whether the last request to iCloud succeeded, when it was checked, and the last error (never containing the password);
  - a `work` object: whether the intake is configured (or which key is missing), the snapshot's `received_at`, its number of events, how many events were left out as invalid, the dates it covers, when the last poll ran, whether it succeeded, and its error (never containing the key);
  - the calendars, with `id`, `name`, `color`, `writable`, `source` (`icloud` or `intake`), `use`, `inAgenda` and `default`.
- `PUT settings`: `use` and `inAgenda` per calendar id, and the default calendar id. It SHALL reject unknown ids, and a default that is not used or not writable, with HTTP 400.
- `GET agenda`: the exact calendar section text the prompt gets now, and when it was fetched.
- `GET changes`: log entries, newest first (`limit`, default 50, at most 200). Each entry SHALL have its source, action, scope, title, a summary of before and after, whether it was undone, and whether it can still be undone.
- `POST changes/:id/undo`: undo that entry with the same rules as `calendar_undo`, except the 24-hour limit, logged with source `portal`. An entry that cannot be undone SHALL answer HTTP 409 with the reason and, when the event changed since, its current version.
- `POST refresh`: rediscover calendars, poll the intake and refresh the agenda, then answer as `GET status`.

#### Scenario: Default must be writable
- **WHEN** `PUT settings` names a read-only calendar, such as Work, as the default
- **THEN** the response is HTTP 400 and the settings are unchanged

#### Scenario: Undo from the portal
- **WHEN** `POST changes/:id/undo` is called for an edit made two days ago and the event is unchanged since
- **THEN** the previous version is restored and a new log entry with source `portal` is added

#### Scenario: Work status
- **WHEN** a snapshot with 218 events received at 14:45 is stored and the last poll found nothing waiting
- **THEN** `GET status` shows `work` with that `received_at`, 218 events and a successful last poll, and lists Work with `source: "intake"` and `writable: false`

### Requirement: Calendar portal page

The module UI SHALL add a "Calendar" entry to the portal navigation, with a page at `/m/calendar` that has two tabs.

**Overview** SHALL show:
- the iCloud connection status (username, connected or the last error, last checked), or that iCloud is not configured;
- the work calendar status (last update received, number of events and the dates they cover, last poll and its error), or that the intake is not configured;
- a refresh button;
- the calendars, each with its colour, a read-only badge when not writable, an "Outlook" badge for the Work calendar, and controls for `use`, `inAgenda` and the default for new events;
- the agenda text exactly as Friday currently gets it.

**Changes** SHALL list the change log (time, source, action, title, before and after), with an Undo button on each entry that can still be undone.

The page SHALL NOT show an event grid or offer event editing.

#### Scenario: Settings saved
- **WHEN** the user turns off "in agenda" for Work on the Overview tab
- **THEN** the setting is saved and the agenda preview no longer shows Work events after the next refresh

#### Scenario: Undo from Changes
- **WHEN** the user clicks Undo on a change that can still be undone
- **THEN** the change is reverted, the list shows it as undone, and a new entry appears

#### Scenario: Work calendar status shown
- **WHEN** the intake is configured and a snapshot was received at 14:45
- **THEN** the Overview shows the work calendar was last updated at 14:45, with its number of events

### Requirement: Work calendar from the intake

When `INTAKE_URL` and `INTAKE_KEY` are both set, the module SHALL read the user's work calendar from the intake service. It SHALL ask for it with `POST <INTAKE_URL>`, header `Authorization: Bearer <INTAKE_KEY>` and JSON body `{"subject":"calendar"}`, on every agenda refresh and on the portal's refresh, whether or not the Work calendar is used. The key SHALL be sent only to the configured URL: a redirect SHALL be treated as a failed poll and not followed, and a request SHALL give up after 30 seconds. The answer is `{"messages": [...]}`, where each message has `id`, `subject`, `received_at` and `content`: one full snapshot of the calendar as an array of events. Because the intake removes what it returns, the module SHALL keep the snapshot it uses in Friday's database, so it survives restarts, and store it before using it. A poll that returns no messages SHALL leave the stored snapshot as it is. Otherwise the module SHALL take the newest usable message by `received_at` (the later one in the array on a tie) that is newer than the stored snapshot, and replace the whole snapshot with it. Messages with another subject SHALL be ignored. A message is usable when `content` is an array with at least one valid event. An empty list SHALL be treated as a fault in the flow, because its window always holds meetings, and never as a free calendar. A valid event has a string `subject`, `start` and `end` as ISO 8601 date-times with an offset, `end` not before `start`, and a boolean `isAllDay`. Invalid events SHALL be left out and counted. When no message in a poll is usable, the stored snapshot SHALL be kept and the poll recorded as failed, with the reason. A snapshot with exactly 256 events SHALL be logged as possibly cut off by the flow. A failed poll, an HTTP 401 or 403 (reported as the intake refusing `INTAKE_KEY`), an unreachable intake or invalid JSON SHALL NOT affect the iCloud calendars. `INTAKE_KEY` SHALL NOT appear in logs, tool results, route responses or error messages.

#### Scenario: New snapshot
- **WHEN** a poll returns one message with 218 valid events
- **THEN** the stored snapshot is replaced by those 218 events, and its time is that message's `received_at`

#### Scenario: Nothing waiting
- **WHEN** a poll returns `{"messages": []}` and a snapshot was stored earlier
- **THEN** the stored snapshot and its events are unchanged

#### Scenario: Several deliveries queued
- **WHEN** a poll returns five messages received at 14:08, 14:27, 14:32, 14:33 and 14:45
- **THEN** only the 14:45 message becomes the snapshot, and the others are not merged into it

#### Scenario: Newest delivery unusable
- **WHEN** the newest message's `content` is not an array and the message before it is usable and newer than the stored snapshot
- **THEN** the message before it becomes the snapshot

#### Scenario: Old-format events
- **WHEN** a message's events have `start` values without an offset, like `2026-11-25T09:00:00.0000000`
- **THEN** those events are left out as invalid, and when none is valid the stored snapshot is kept and the poll is reported as failed

#### Scenario: Empty delivery
- **WHEN** a snapshot was stored earlier and a poll returns one message whose `content` is `[]`
- **THEN** the stored snapshot is kept and the poll is reported as failed, saying the delivery had no events

#### Scenario: Restart
- **WHEN** Friday restarts after storing a snapshot and the intake has nothing waiting
- **THEN** the Work calendar's events come from the stored snapshot

#### Scenario: Intake rejects the key
- **WHEN** the intake answers HTTP 401
- **THEN** the poll fails with an error saying the intake refused `INTAKE_KEY`, containing no part of the key, and the iCloud agenda is still refreshed

#### Scenario: Redirect
- **WHEN** the intake answers with a redirect to another host
- **THEN** the redirect is not followed and the poll fails

### Requirement: Work events

Every event in the snapshot SHALL be one occurrence in the Work calendar, never a series: it SHALL NOT be returned as recurring, and recurrence fields in the payload SHALL be ignored. Timed events SHALL use the instants given by `start` and `end`, shown in `FRIDAY_TIMEZONE` like every other event. An all-day event (`isAllDay: true`) SHALL take its days from the date part of `start` and `end` as written, without converting them to another zone, with `end` exclusive. So `2026-12-15T00:00:00+00:00` to `2026-12-16T00:00:00+00:00` is the single day 15 December. The `subject` SHALL be the title. A title starting with `Geannuleerd:`, `Canceled:` or `Cancelled:` (any case) SHALL lose that prefix, and the event SHALL have the status `cancelled`. Otherwise `showAs` SHALL give the status: `tentative` becomes `tentative`, `free` becomes `free`, and `oof` becomes `out of office`. Every other value gives no status. The location SHALL be built from the parts of `location` separated by `;`. Each part SHALL be trimmed. Parts that are a URL (`http://` or `https://`) or `Microsoft Teams Meeting` (any case) SHALL become `online`, listed once and first. A leading `_` SHALL be removed from the other parts. Empty parts SHALL be dropped, and the rest joined with `, `. Work events have no notes.

#### Scenario: Timed event
- **WHEN** it is 2026, an event runs from `2026-09-11T13:00:00+00:00` to `2026-09-11T14:00:00+00:00` and `FRIDAY_TIMEZONE` is `Europe/Amsterdam`
- **THEN** it is returned with `when: "Fri 11 Sept, 15:00-16:00"`

#### Scenario: All-day in UTC
- **WHEN** it is 2026, an all-day event runs from `2026-12-15T00:00:00+00:00` to `2026-12-16T00:00:00+00:00` and `FRIDAY_TIMEZONE` is `America/New_York`
- **THEN** it is returned with `when: "Tue 15 Dec, all day"`

#### Scenario: Cancelled meeting
- **WHEN** an event's subject is `Geannuleerd: Interview SBP - Renske`
- **THEN** it is returned with the title `Interview SBP - Renske` and the status `cancelled`

#### Scenario: Online meeting with a room
- **WHEN** an event's location is `Microsoft Teams Meeting; _Video Conference; SkyLounge`
- **THEN** its location is `online, Video Conference, SkyLounge`

#### Scenario: Meeting link
- **WHEN** an event's location is a Webex URL
- **THEN** its location is `online`

#### Scenario: Id survives an hourly snapshot
- **WHEN** a Work meeting was listed and a new snapshot arrives with that meeting unchanged
- **THEN** listing the day again returns the meeting once, with the same title and `when`, still without an `id`

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
