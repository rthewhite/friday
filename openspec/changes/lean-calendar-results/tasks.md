# Tasks

## 1. Compact events

- [x] 1.1 Split `readOnlyReason()` into a calendar-level reason and an invitation reason (texts unchanged, see design D2). Make `view()` return the compact `EventView` (design D1, D2, D6):
  - `title` and `when`;
  - `id` only without a reason;
  - `recurring` only when true;
  - `readOnly` only for an invitation;
  - `location`, `status` and `notes` (`NOTES_MAX` 200) when present;
  - no `start`, `end`, `allDay` or `calendar`.

  Verify in `test/tools.test.ts` (the invitation in `test/confirm.test.ts`, where it is seeded):
  - an all-day event's `when`;
  - a next-year `when`;
  - an editable recurring occurrence has `id` and `recurring: true`;
  - an invitation has no `id` and has its own `readOnly`;
  - notes are cut at 200;
  - no event carries `start`/`end`/`allDay`.
- [x] 1.2 Give `create()`'s `created` and `confirm()`'s edited `event` their `calendar` name (design D3). Verify in `test/tools.test.ts` and `test/confirm.test.ts` that both carry `id`, `when` and `calendar`. Update the existing assertions there that read `start`/`end`/`allDay`.
- [x] 1.3 Update `test/work.test.ts` for the new shape:
  - the timed and all-day-in-UTC scenarios assert `when`;
  - Work events have no `id`.

  Rewrite the id-across-snapshots test to the reworded scenario: after an unchanged new snapshot, the meeting is listed once, with the same title and `when` and no `id`. Keep any test of the internal uid.
- [x] 1.4 Run `pnpm --filter @friday/module-calendar test` and `pnpm --filter @friday/module-calendar typecheck`, both green.

## 2. Listing: one-day default and list-level fields

- [x] 2.1 Change `list()`'s default `to` to the end of the local day `from` falls on, keeping 365 days with a `query` (design D4). Verify in `test/tools.test.ts`:
  - `{}` returns only today's events when tomorrow also has events;
  - `from: "2026-10-12"` alone returns only that day;
  - `from: "2026-10-12T15:00"` alone stops at midnight;
  - the query search still reaches 365 days.
- [x] 2.2 Add the list-level `calendar` (when all returned events share one calendar; then none on the events) and `readOnly` (calendar name to reason, once per read-only calendar with returned events) (design D2, D3). Verify in `test/tools.test.ts` and `test/work.test.ts`:
  - a Work-only day gives `calendar: "Work"` and `readOnly.Work` mentioning Outlook;
  - Home plus Work gives a per-event `calendar` and only `Work` under `readOnly`;
  - a read-only holiday calendar is keyed by its name;
  - an empty result has neither field.
- [x] 2.3 Add a size guard in `test/work.test.ts`: the list result for one day with the fixture's Work meetings stays under 150 characters per event (`JSON.stringify` length / event count). This keeps the shape from growing back.
- [x] 2.4 Rewrite the `calendar_list_events` description in `src/tools.ts`:
  - always pass `from`/`to` for the days the user asked about;
  - without `to` it covers one day; `{}` is today, which is already in context;
  - events without an id can't be changed, and `readOnly` says why.

  Adjust the `calendar_update_event` and `calendar_delete_event` descriptions if they mention fields that are gone. Verify by reading the registered descriptions in `test/module.test.ts`, or the existing tool-declaration test if there is one.
- [x] 2.5 Update the README's `calendar_list_events` paragraph (the default range, the compact fields, the list-level `calendar`/`readOnly`, no id for read-only events). Update the calendar part of `openspec/config.yaml`'s context to match. Verify that both no longer mention `start`/`end`, `readOnly` per event or a 7-day default.
- [x] 2.6 Run `pnpm --filter @friday/module-calendar test` and `typecheck`, both green.

## 3. Agenda dates

- [x] 3.1 In `src/agenda.ts`, label today and tomorrow with the year and ISO date, and add the coming-days line for days 2 to 8 after the header (design D5). The line is also present on the early-return path where no source is available. Verify in `test/agenda.test.ts`:
  - on Saturday 3 October 2026 (the harness clock), today reads `Saturday 3 October 2026 (2026-10-03)`;
  - the line runs `Mon 2026-10-05` … `Sun 2026-10-11`;
  - the midnight rollover shifts the line by a day;
  - with every source unavailable the line is still there;
  - when events are cut at 2000 characters, the line survives.
- [x] 3.2 Update the README's agenda paragraph to mention the ISO dates and the coming-days line, and the agenda wording in `openspec/config.yaml`'s context. Verify by reading both.
- [x] 3.3 Run `pnpm --filter @friday/module-calendar test` and `typecheck`, both green.

## 4. Integration

- [ ] 4.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree, all green.
- [ ] 4.2 Chat check against the fakes or a dev server on a free port (`FRIDAY_PORT=8081 FRIDAY_CORE_URL=http://localhost:8081 pnpm dev`). Ask "what does my calendar look like on Monday?" and confirm:
  - the recorded `calendar_list_events` call passes Monday's date as `from`, without `{}`;
  - its result has the compact shape.

  Stop the dev server afterwards.
