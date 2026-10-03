# Design

## Context

See proposal.md for motivation and specs/calendar/spec.md for the behaviour. Constraints that shape the approach:

- iCloud has no REST API or OAuth for calendars. It serves CalDAV at `https://caldav.icloud.com/`, which redirects discovery to a per-account host (`https://pNN-caldav.icloud.com/<dsid>/...`). Authentication is HTTP Basic with the Apple ID and an app-specific password, which requires two-factor authentication on the account.
- Modules depend only on `@friday/sdk`. The closest existing pattern is `modules/travel`: an upstream client over an injectable `fetch`, credentials read per call through `ctx.config`, and typed upstream errors. `modules/brain` shows module migrations (`ctx.db`), routes (`ctx.http`), a job (`ctx.jobs`), prompt context (`ctx.prompt.addContext`) and a module UI (`friday.ui` + `@friday/portal-ui`).
- `ctx.prompt.addContext` providers are synchronous and run on the path that opens a voice session. `ctx.storage` is async. `init` may be async.
- Tool handlers get `{ channel, conversationId }`. A voice session's first exchange has no conversation id yet.
- Travel already has a strict ISO 8601 parser with household-zone resolution, private to `modules/travel/src/helpers.ts`.

## Goals / Non-Goals

**Goals:**
- Tool results that a voice model can read out reliably: short ids, `when` text, read-back and overlaps built in.
- No write that the user didn't hear about. Edits and deletions are mechanically two-step, and every write can be reverted.
- Never lose an event because of a stale view: every write is conditional on the ETag seen.
- Work with only the parts of CalDAV that iCloud actually supports, tested against recorded iCloud-shaped responses.

**Non-Goals:**
- A local mirror or sync of the calendar (reads go live to iCloud). The cache covers only the agenda window.
- A general CalDAV client for other servers. Nothing prevents it later, but we only test iCloud's shapes.
- Alarms, attendees, invitations (RSVP), moving events between calendars, and "this and following".

## Decisions

### D1. A thin CalDAV client over `fetch` instead of `tsdav`

Friday needs six request types:
- `PROPFIND` for the principal, the calendar home and the calendar list (with `displayname`, `calendar-color`, `resourcetype`, `supported-calendar-component-set`, `current-user-privilege-set`), plus the principal's `calendar-user-address-set`;
- `REPORT` `calendar-query` with a `time-range` filter;
- `GET`;
- `PUT` with `If-Match` or `If-None-Match: *`;
- `DELETE` with `If-Match`.

A small client in `src/caldav.ts` over an injectable `fetch` does this, using `fast-xml-parser` for the multistatus bodies. It follows the travel pattern, keeps tests on plain fake responses, and gives full control over errors and logging (no URLs with credentials, no bodies in logs).

*Alternative:* `tsdav` covers this, but it brings its own fetch polyfill and account abstraction, is harder to fake per request in tests, and wraps errors in ways that would make the 401 and 412 handling the specs require awkward to implement.

Discovery results (principal, home, calendars, own addresses) are cached in memory, keyed by username, and rebuilt by the refresh job or when the username changes. A 401 never retries.

### D2. `ical.js` for parsing, recurrence and time zones

`ical.js` (v2, ESM, typed) parses VCALENDAR objects and expands RRULE/RDATE/EXDATE with overrides (`RECURRENCE-ID`) through `ICAL.Event` and `iterator()`. It also resolves each object's embedded `VTIMEZONE`, which iCloud always includes, so floating and TZID times turn into real instants.

Expansion happens locally, because the server's `<C:expand>` returns UTC and drops the master, which edits need. Writes change the parsed component and re-serialize it, so properties Friday doesn't know about (alarms, attendees, URL, X-APPLE-*) are kept as they are.

New events get a UUID `UID`, `DTSTAMP`, `TZID=<FRIDAY_TIMEZONE>` with a matching `VTIMEZONE` built from `Intl` transitions for the years the event spans, and `RRULE:FREQ=<repeat>[;UNTIL=...]`. All-day events use `VALUE=DATE`, with the exclusive end iCalendar requires (the tool's inclusive `end` plus one day).

### D3. Short in-memory event handles

Tools never expose CalDAV URLs. `calendar_list_events` (and create/confirm results) register each returned event in an `EventHandles` map: a handle like `e7k2` maps to `{ calendarId, objectUrl, etag, uid, recurrenceId?, snapshot }`. The map is an LRU with up to 1000 entries and a 2-hour TTL that is refreshed whenever the event is returned again. Short ids are easier for the model to copy correctly by voice, can't be guessed into another calendar, and make "list first, then edit" structural.

A restart drops the map, and the error tells the model to list again. This is cheap, and correct because the model rebuilds its view.

*Alternative:* encode the URL plus the recurrence id as an opaque base64 id. That survives restarts, but the ids are long and the model copies them badly.

### D4. Confirmation tokens hold the exact change

`calendar_update_event` and `calendar_delete_event` compute the full result up front:
- the new ICS (edit, or occurrence deletion via `EXDATE`, with an override removed if one exists);
- or a `DELETE` (series deletion).

Each preview is stored under a random 6-character token (unambiguous alphabet), together with the ETag the preview was based on, the before/after summaries, the source channel and conversation id. Tokens live in memory, are single-use and expire after 5 minutes. `calendar_confirm` replays exactly that request with `If-Match: <etag>`. A `412` (or `404`) means the event changed meanwhile: the client fetches the current object and the error carries its summary.

Tokens are not bound to a conversation, because the first voice exchange has no id. Being random, single-use and short-lived is enough.

*Alternative:* rely on prompt wording alone to make the model ask first. That was rejected during exploration (option B), because the model can skip the question, but it can't skip the tool.

Series edits apply the identified occurrence's time-of-day shift to the master's `DTSTART`/`DTEND` and leave overrides alone. A change of date is refused (the spec explains why: `BYDAY` rules would quietly fight the new start). Occurrence edits add or replace the override `VEVENT` with `RECURRENCE-ID` set to the occurrence's original start.

### D5. Ownership and writability

A calendar is writable when its `current-user-privilege-set` contains `write` or `write-content`. When iCloud omits the property, the calendar is assumed writable, and a `403` on write marks it read-only in the discovery cache and becomes the read-only error.

An event counts as an invitation when it has an `ORGANIZER` whose `mailto:` address is not in the principal's `calendar-user-address-set` (compared case-insensitively, with `ICLOUD_USERNAME` always counted). Events without an `ORGANIZER` are the user's own.

### D6. Change log in `calendar__changes`

Module migration 1 creates:

```
calendar__changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,          -- create | update | delete | undo
  scope TEXT,                    -- occurrence | series | NULL (non-recurring)
  calendar_id TEXT NOT NULL,
  object_url TEXT NOT NULL,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  before_summary TEXT,           -- JSON: when/title/location, for lists
  after_summary TEXT,
  before_ics TEXT,               -- whole object as it was; NULL for create
  after_ics TEXT,                -- whole object as written; NULL for delete
  after_etag TEXT,               -- ETag after the write; NULL for delete
  source TEXT NOT NULL,          -- voice | chat | portal
  conversation_id TEXT,
  undo_of INTEGER,               -- plain ids, no foreign keys: pruning may drop the other row
  undone_by INTEGER
)
```

Whole-object ICS makes undo uniform:
- *create*: `DELETE` with `If-Match: after_etag`;
- *update* or *occurrence delete*: `PUT before_ics` with `If-Match: after_etag`;
- *series delete*: `PUT before_ics` with `If-None-Match: *`.

When iCloud's `PUT` response carries no `ETag`, the client reads it back with a `HEAD` or `PROPFIND` before logging. Undo rows (action `undo`) set `undo_of` and the original row's `undone_by` in one transaction, and undo rows are never picked by `calendar_undo`. A tool call without a channel is logged as `chat`. After each insert, rows beyond the newest 500 are deleted.

### D7. Agenda cache and job

`calendar/refresh` runs `everyMs: 300_000` with `timeoutMs: 60_000`. It does three things:
1. rediscovers calendars;
2. stores the discovery in memory;
3. fetches events for today through the day after tomorrow (three local days) in used calendars, and expands them.

The fetched events are stored as `{ fetchedAt, events }`. The prompt provider filters by `inAgenda` and works out "today" and "tomorrow" from the clock when it's called. That's why the window has a third day: the midnight rollover still has a full "tomorrow".

`init` loads settings from `ctx.storage` into memory (async init), schedules the job and calls `ctx.jobs.trigger("refresh")`. It makes no network call itself, so a down iCloud never fails the module. Writes trigger the job after they succeed. A failed refresh keeps the previous cache and records the error for `GET status`.

### D8. Settings in `ctx.storage`, mirrored in memory

The key `settings` holds `{ calendars: { [id]: { use, inAgenda } }, defaultId? }`, and the calendar id is the last path segment of its CalDAV URL. Calendars with no entry use the defaults (on, on). The in-memory copy serves the synchronous prompt provider and the tools. `PUT settings` validates against the current discovery, writes storage, then updates memory and triggers a refresh.

### D9. Shared date-time parser in the SDK

Travel's `toRfc3339`, `zoneOffsetMinutes`, `parseOffset` and `formatOffset` move to `packages/sdk/src/time.ts` and are exported as `parseDateTime(value, zone)`, which returns `{ value, instant } | null`. `offsetMinutes` and `formatOffset` are exported too, for the calendar's output times and generated `VTIMEZONE`s. Travel imports it, and its tests for the format rules move to the SDK. Calendar also uses `startOfLocalDay` and `localDate` for date-only inputs and day windows. This keeps "2026-10-08T15:00" meaning the same in both modules, and avoids a second copy of the DST-correct offset logic.

### D10. Tool results built for speech

Results put `when` first and keep `notes` short. Write results include a `say` hint, for example `Created "Plumber" on Tue 13 Oct, 09:00-10:00 in Home.`, so the read-back is consistent. Preview results include `instruction: "Read this change back to the user and call calendar_confirm only after they agree."` Errors are thrown as typed errors (`CredentialRejectedError`, `ReadOnlyError`, `StaleEventError` with `current`, `UnknownEventError`, `TokenError`, `UpstreamError`), so the registry reports them as tool errors, like travel does.

### D11. Portal UI

`modules/calendar/src/ui/index.ts` defines the module UI (`nav: { label: "Calendar", icon: "calendar", order: 30 }`) with one route, `CalendarPage.vue`, which holds the Overview and Changes tabs (`Tabs`, `Card`, `DataTable`, `StatusDot`, `Badge`, `Button` from `@friday/portal-ui`). A `calendar` path is added to `Icon.vue`. The module declares `ui: true` and `"friday": { "ui": "./src/ui/index.ts" }` plus the `./ui` export, like brain.

## Risks / Trade-offs

- **iCloud CalDAV quirks** (redirects, missing `ETag` on `PUT`, privilege sets left out, rate limiting) → Discovery follows redirects manually and keeps the Basic header only for `*.icloud.com` hosts. ETags are read back when missing (D6). Fixtures come from real iCloud response shapes. One manual end-to-end check against the user's account is part of the tasks.
- **One app-specific password unlocks mail and contacts too** → It's stored as a secret (encrypted, write-only), sent only to `*.icloud.com`, and never logged. The README tells the user they can revoke it on its own.
- **Agenda in every prompt, including Talk-page sessions that need no device key** → Accepted by the user during exploration. The `inAgenda` setting limits what goes in.
- **The model confirms without asking** → The model could still call `calendar_confirm` right after the preview without asking the user. Tool descriptions and the preview's `instruction` say not to, and undo plus the change log cover the remaining risk. That trade-off was chosen over a hard human-in-the-loop UI.
- **Handles and tokens are lost on restart** → The error messages say to list or preview again. Nothing is half-applied, because a token holds a single conditional request.
- **Recurrence edge cases** (moved occurrences, `EXDATE` in other zones, DST) → `ical.js` does the expansion. There are dedicated tests for moved and deleted occurrences and a weekly event across the late-October DST change.
- **Large calendars** → Range queries are bounded (366 days, 50 results), and the agenda only fetches three days.

## Migration Plan

This is a new module with its own migration (`calendar__changes`), so no data migrates. To deploy: set `ICLOUD_USERNAME` and `ICLOUD_APP_PASSWORD` in Settings > Configuration, then reload `calendar`. Until then the module shows as `failed`, as travel does without its key. To roll back, leave it out with `FRIDAY_MODULES` or revert the change. The table is harmless when unused. The SDK parser move doesn't change travel's behaviour, and its existing tests guard that.

## Open Questions

- Whether iCloud returns `calendar-color` for every calendar. The UI falls back to a neutral dot, so this doesn't change anything else.
