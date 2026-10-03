# Proposal

## Why

Friday has no idea what's on the user's calendar, so it can't answer "what's on tomorrow?" or "when do I need to leave for the dentist?", and it can't take "put the plumber in for Tuesday at 9" off their hands. The calendar lives in iCloud. Apple has no REST API or OAuth for it, but iCloud serves calendars over standard CalDAV with an app-specific password, so a module can read and write it directly.

## What Changes

- New in-process module `calendar` (`modules/calendar`) that connects to one iCloud account over CalDAV: `ICLOUD_USERNAME` (Apple ID email, plain) and `ICLOUD_APP_PASSWORD` (app-specific password, secret). Both are required. The password is read per request, so a new one works without a reload. A rejected password produces an error that says how to make a new one, and the password never appears in logs, errors or tool results.
- Calendars are discovered from the account, so a calendar shared with the user later just shows up.
- Tools on voice and chat:
  - `calendar_list_events`: events in a range, optionally filtered by text, with recurring events expanded, in `FRIDAY_TIMEZONE`.
  - `calendar_create_event`: creates the event right away and returns it for a read-back, along with any overlapping events.
  - `calendar_update_event` and `calendar_delete_event`: take an event id from a previous list and a scope (`occurrence` or `series`). They return a preview and a short-lived confirmation token and change nothing yet.
  - `calendar_confirm`: commits a previewed change, refusing if the event changed in the meantime.
  - `calendar_undo`: reverts Friday's most recent change.
- Every write is logged with the event's before and after state, plus the channel and conversation it came from, which is what makes undo possible.
- Friday's prompt gets a short agenda for today and tomorrow, served from a cache that a background job refreshes every few minutes.
- A portal page at `/m/calendar`:
  - **Overview:** connection status, the discovered calendars with per-calendar settings (used by Friday, shown in the agenda, default for new events), and the exact agenda text Friday currently sees.
  - **Changes:** Friday's writes, each with an Undo button.

  It is not a calendar app: there's no event grid and no editing forms.
- `@friday/sdk` gains a strict date-time parser (moved out of the travel module) so both modules read "2026-10-08T15:00" the same way in the household zone. Travel's behaviour does not change.

Out of scope: email, contacts, reminders, more than one account, moving events between calendars, "this and all following" edits, changing invitations organised by someone else, and proactive or unprompted reminders (Friday can't speak outside a session).

## Capabilities

### New Capabilities

- `calendar`: the `calendar` module, which covers the iCloud CalDAV connection and credentials, calendar discovery and settings, the event tools with confirmation, the change log and undo, the agenda in the prompt, and the `/m/calendar` portal page with its routes.

### Modified Capabilities

- `module-system`: the household time zone helper in `@friday/sdk` also exports a strict date-time parser that resolves offset-less values in a given zone.

## Impact

- **New package** `modules/calendar` (`@friday/module-calendar`), with new dependencies `ical.js` (iCalendar parsing, recurrence expansion, time zones) and `fast-xml-parser` (CalDAV responses). Requests go through an injectable `fetch`, like travel.
- **Core:**
  - `packages/core/src/modules.ts` and `packages/core/package.json` register the module.
  - The `Dockerfile` copies its `package.json`.
- **SDK:** `packages/sdk/src/time.ts` gains the parser. `modules/travel/src/helpers.ts` uses it instead of its own copy, and the tests move along with it.
- **Portal:** a module UI in `modules/calendar/src/ui` built on `@friday/portal-ui`. A `calendar` icon is added to `packages/portal-ui/src/components/Icon.vue`.
- **Storage:** module migration 1 creates `calendar__changes` in friday.db. Calendar settings live in `ctx.storage`.
- **New routes** under `/api/modules/calendar/`.
- **Network:** outbound HTTPS to `caldav.icloud.com` and the per-account `pNN-caldav.icloud.com` host.
- **Docs:**
  - README: a calendar section, including how to create an app-specific password.
  - `.env.example`: the two keys.
  - `deploy/k8s.yaml`: a comment listing the keys.
  - `openspec/config.yaml`: context.
- **Other changes in flight:** none (`openspec list` is empty).
