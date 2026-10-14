# Proposal

## Why

Calendar tool results are much bigger than the answers they feed. In production, "Hoe ziet mijn kalender voor maandag er uit?" made Friday call `calendar_list_events` with no range. That defaults to 7 days, so it returned the whole week (over 4000 characters) for a question about one day. In chat, that result is replayed on every later turn of the conversation. Even a one-day result spends about 380 characters per event, and only about a quarter of that is what the user hears: the title, time, location and status. The rest is overhead:
- the same "comes from Outlook" reason on every Work event (30%);
- the time three times over: `start`, `end` and `when` (27%);
- flags and an id that a read-only event can't use.

## What Changes

- **Compact events.** Events returned by the calendar tools shrink to `title`, `when`, and `location`, `status` and `notes` only when present.
  - An `id` is included only when Friday can change the event. `recurring` is included only when true.
  - `start`, `end`, `allDay` and `readOnly` are dropped: `when` already says it (the year is in `when` for dates outside the current year).
  - In a list, `calendar` is given once for the whole result when every event is in the same calendar, and per event otherwise.
  - A read-only calendar's reason is given once per list, under `readOnly`, keyed by calendar name. Only an invitation keeps a reason of its own, on the event.
  - Notes are cut to 200 characters instead of 500.
  - **BREAKING (tool result shape):** the model reads these results, nothing else does. The portal and routes don't use them.
- **One day by default.** Without `to`, `calendar_list_events` covers one day: the rest of the day `from` falls on, or today when there is no `from`. With a `query`, it still covers 365 days.
  - The tool description tells Friday to always pass `from` and `to` for the days the user asked about.
- **Dates the model can resolve.** The agenda in the prompt labels today and tomorrow with their ISO dates. It also adds one line mapping the next seven days to their dates (`Mon 2026-10-12`, ...), so "maandag" or "next Thursday" resolves without guessing or a `get_current_time` call.
- The today/tomorrow agenda stays in the prompt as it is: it is compact and capped, and voice answers "what's on today" from it without a tool call.

Out of scope:
- what other tools return (previews, overlaps, undo already use the short summary);
- the agenda's event lines and its 2000-character cap;
- portal pages and routes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `calendar`:
  - "Event times and identity" (the fields of a returned event);
  - "Listing events" (the default range, and the list-level `calendar` and `readOnly`);
  - "Invitations and read-only events" (where the reason appears; read-only events get no id);
  - "Agenda in the prompt" (ISO dates and the coming-week line);
  - "Work events" (scenarios that named the dropped fields).

## Impact

- `modules/calendar/src/service.ts`: `EventView`, `view()`, `list()` (range default, list-level `calendar`/`readOnly`), and `create()`/`confirm()` results that embed a view.
- `modules/calendar/src/tools.ts`: the `calendar_list_events` description.
- `modules/calendar/src/agenda.ts`: day labels and the coming-week line.
- `modules/calendar/src/format.ts`: possibly a helper for the coming-week line.
- Tests: `modules/calendar/test/tools.test.ts`, `agenda.test.ts`, `confirm.test.ts`, `work.test.ts` (assertions on `start`/`end`/`allDay`/`readOnlyReason`).
- Docs: the README's calendar section and the calendar part of `openspec/config.yaml`'s context.
- No config, migration, route or portal change. No other in-flight change touches the calendar module.
