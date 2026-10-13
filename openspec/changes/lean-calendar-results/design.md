# Design

## Context

The motivation and the production evidence are in proposal.md (Why).

Every event a calendar tool returns is built by `CalendarService.view()` (`modules/calendar/src/service.ts`) as `EventView`. That shape is used in three places: `list()`'s `events`, `create()`'s `created`, and `confirm()`'s `event` for an edit. Nothing outside the tools consumes it: the portal routes use the agenda, the settings and the change log, never `view()`.

Previews, overlaps, undo and stale errors already use the short `EventSummary` (`title`, `when`, `calendar`, `location`) and are not touched.

`whenText()` in `format.ts` already includes the year when a date is outside the current year, so `when` determines the event's days and times by itself.

The agenda (`agenda.ts`) labels days as `Today, Saturday 10 October:` with no year or ISO date. The model has to call `get_current_time` or guess to turn "maandag" into a `from` date. In one of the two production conversations it called `get_current_time`. In the other it called the list tool without a range, which got the whole week.

## Goals / Non-Goals

**Goals:**
- A typical Work meeting in a list result takes about 120 characters instead of about 380.
- A question about one day never pulls in more than that day, even when the model leaves out `to`.
- The date for a day name is in the prompt.

**Non-Goals:**
- Changing `whenText()` or the `say` texts, which voice reads out.
- Changing the agenda's event lines, cap or refresh.
- A plain-text result format: results stay JSON objects.

## Decisions

### D1: `when` is the only time field

Drop `start`, `end` and `allDay` and keep `when`.

`when` is what the model says out loud. It is also unambiguous: it gives the weekday and date, the year outside the current year, the time range or `all day`, and it handles events across midnight. With the ISO dates now in the agenda, the model can turn it into a `start` for an edit when needed. A wrong conversion is caught where it matters: `calendar_update_event` previews `before` and `after` with their `when`, and Friday reads that back before confirming.

Alternatives considered:
- Keep ISO `start`/`end` and drop `when`: still about 50 characters, and the model has to rephrase every time for voice.
- Keep both, compacted: saves less, and still says the time twice.

### D2: `id` only when Friday can change the event

`view()` asks `readOnlyReason()` first and requests a handle only when there is no reason. So a read-only event carries no `id`, and the handle store holds fewer entries.

The refusal in `previewUpdate`/`previewDelete` stays, because an id can outlive a change in the calendar's writability or in the account's addresses.

A missing `id` is the signal that the event can't be changed. The reason that goes with it is placed as follows:
- **Calendar-level reasons** (a Work event, or a calendar that isn't writable) are collected in `list()` into `readOnly: { [calendarName]: reason }`. Each reason is worded without the calendar name, since the name is the key.
- **An invitation** keeps `readOnly: "<reason>"` on the event, because the organizer differs per event.

`readOnlyReason()` is split so the caller can tell the two kinds apart: a calendar part and an event part.

### D3: List-level `calendar`

`list()` first builds the views without `calendar`, then sets it:
- once at the top when the returned events (after the 50 cut) share one calendar;
- otherwise on each event.

An empty result gets neither. `create()` and `confirm()` add `calendar` to their single event, as the spec requires.

### D4: Default range is one local day

Without `to`, `list()` ends at `endOfLocalDay(<local date of from>)`. `from` is a date, an instant, or today. With a `query`, the 365-day default is unchanged.

This keeps `{}` cheap (today, which is already in the prompt), and makes a forgotten `to` cost one day rather than seven.

The tool description changes to match. It says to pass `from` and `to` for the days asked about, and that `{}` gives today only.

### D5: Coming-days line in the agenda

`render()` gets the year and ISO date in the day labels, for example `Today, Saturday 10 October 2026 (2026-10-10):`. After the header it adds one non-event line, for example `Coming days: Mon 2026-10-12, Tue 2026-10-13, ..., Sun 2026-10-18.`.

This line is built from `localDate(now)` with `addDays`. It is also added on the early-return path, where no source is available. Because `cut()` only drops event lines, it survives the cut on its own.

The line covers days 2 to 8 from today: today and tomorrow are already labelled, and that range gives every weekday exactly once.

### D6: Notes cut to 200

`NOTES_MAX` goes from 500 to 200. Notes are rare on iCloud events and absent on Work events. This only caps the worst case when notes are long, such as a pasted invite text in a week of events.

## Risks / Trade-offs

- **[Risk]** The model mis-converts a `when` into a `start` for an edit, for example around a year boundary.
  **Mitigation:** the year is in `when` outside the current year and in the agenda labels. Edits always go through a preview that is read back.
- **[Risk]** The model tries to edit an event without an `id`, for example by passing its title.
  **Mitigation:** `calendar_update_event` already errors without an id. The list result's `readOnly` explains why, and the description of `calendar_update_event` says to take the id from the list.
- **[Trade-off]** Old conversations replay tool results in the old shape. That is harmless: they are only history.
- **[Risk]** A result where some events have a `calendar` and others don't would confuse the model.
  **Mitigation:** D3 is all or nothing per result, and a test covers both cases.

## Migration Plan

No data, config or route change. Deploy as usual. Rolling back is a revert, and nothing persists in the new shape.
