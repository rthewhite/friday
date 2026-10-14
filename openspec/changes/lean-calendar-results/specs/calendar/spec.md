## MODIFIED Requirements

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
