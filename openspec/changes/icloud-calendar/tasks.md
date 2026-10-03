# Tasks

## 1. SDK: shared date-time parser

- [x] 1.1 Move travel's `toRfc3339`, `parseOffset`, `zoneOffsetMinutes` and `formatOffset` into `packages/sdk/src/time.ts` and export them as `parseDateTime(value, zone)`, returning `{ value, instant } | null` (design D9). Verify with `packages/sdk/test` cases for the new `module-system` scenarios: offset-less in the zone, own offset kept, 30 February and RFC 2822 rejected, and a time across the October DST change. Run `pnpm --filter @friday/sdk test` and `typecheck`.
- [x] 1.2 Make `modules/travel/src/helpers.ts` use `parseDateTime` and delete its private copies. Verify that `pnpm --filter @friday/module-travel test` and `typecheck` pass with the existing `validateTimeArgs` tests unchanged.
- [x] 1.3 Update the `module-system` mention of the time helper in `openspec/config.yaml` context to name the parser. Verify by reading it back.

## 2. Module scaffold, credentials and registration

- [x] 2.1 Create `modules/calendar` (`@friday/module-calendar`): `package.json` modelled on brain's, with the `./ui` export, `friday.ui`, dependencies `@friday/sdk`, `ical.js` and `fast-xml-parser`, and the portal-ui/vue dev dependencies; plus `tsconfig.json`, and `src/index.ts` with `createCalendarModule({ fetch?, now? })`. The manifest has id `calendar`, `ui: true`, required `ICLOUD_USERNAME` and required secret `ICLOUD_APP_PASSWORD`, and `FRIDAY_TIMEZONE`. Verify that `pnpm install` and `pnpm --filter @friday/module-calendar build` succeed.
- [x] 2.2 Register the module in `packages/core/src/modules.ts` and `packages/core/package.json`, and add its `package.json` line to the `Dockerfile`. Verify that `pnpm --filter @friday/core typecheck` passes and that `GET /api/modules` in a core test lists `calendar` (or that an existing modules test covers it).
- [ ] 2.3 Write `test/module.test.ts` with `createTestHost`. Verify that without `ICLOUD_APP_PASSWORD` the module fails naming the key and registers no tools, and that with both keys it registers all six tools (`calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_confirm`, `calendar_undo`) on voice and chat.
- [x] 2.4 Add a "Calendar (iCloud)" section to the README: what it does, how to create an app-specific password (account.apple.com > Sign-In and Security > App-Specific Passwords, 2FA required), that it can be revoked on its own, and that changing the Apple ID password revokes it. Also add the keys to `.env.example` and the comment in `deploy/k8s.yaml`, and the module line in the README's module table and diagram. Verify that the keys in `.env.example` match the manifest.

## 3. CalDAV client

- [x] 3.1 Implement `src/caldav.ts` over an injectable `fetch` (design D1):
  - discovery: the principal, the calendar home, the calendar list with name, colour, components and privileges, and the own addresses, following redirects manually;
  - `queryRange(calendar, from, to)` (`REPORT calendar-query` with `time-range`);
  - `get`, `put` (with `If-Match` or `If-None-Match`), `delete`, and an ETag read-back.

  Add fixtures in `test/fixtures/` shaped like iCloud's multistatus responses. Verify with `test/caldav.test.ts`:
  - discovery yields event calendars only (a VTODO-only list is excluded);
  - writability comes from privileges, and is assumed when they're missing;
  - a range query returns ICS and ETags;
  - a `PUT` without an `ETag` header triggers a read-back.
- [x] 3.2 Add typed errors in `src/errors.ts`: `CredentialRejectedError` (names the username, explains app-specific passwords and where to create them), `ReadOnlyError`, `StaleEventError` (with `current`), `UnknownEventError`, `TokenError` and `UpstreamError`. Basic auth is sent only to `*.icloud.com` hosts. Verify in `caldav.test.ts`:
  - a 401 produces the credential message;
  - a 412 or 404 on a conditional write becomes `StaleEventError`;
  - a redirect to a non-iCloud host gets no `Authorization` header;
  - no error message or captured log line contains the password.
- [x] 3.3 Read credentials per request and key the discovery cache by username. Verify with a test: after a 401, saving a new password in the test host's config makes the next call succeed without a reload.

## 4. iCalendar layer

- [x] 4.1 Implement `src/ical.ts` on `ical.js` (design D2):
  - parse objects and register their `VTIMEZONE`s;
  - expand occurrences inside a range, honouring `EXDATE` and `RECURRENCE-ID` overrides;
  - map them to the event shape (title, start/end in `FRIDAY_TIMEZONE`, all-day dates with an inclusive end, `when` text, notes cut to 500 characters, `recurring`).

  Verify with `test/ical.test.ts`:
  - a single timed event;
  - a two-day all-day event (`end` is the last day);
  - a weekly event with one moved and one deleted occurrence;
  - a weekly event across the late-October DST change (stays at 09:00 local time);
  - the `when` formats.
- [x] 4.2 Implement invitation detection (design D5): `ORGANIZER` not in the own addresses or `ICLOUD_USERNAME`, compared case-insensitively. Verify with tests: an invitation gets `readOnly` with an "invitation" reason, and an event without an organizer, or organized by the user, does not.
- [x] 4.3 Implement the builders:
  - `buildEvent` (UID, DTSTAMP, TZID plus a generated `VTIMEZONE`, `VALUE=DATE` all-day with an exclusive end, `RRULE` from `repeat`/`repeatUntil`);
  - `applyEdit` (non-recurring; occurrence override with `RECURRENCE-ID`; series time-of-day shift, refusing a date change);
  - `deleteOccurrence` (`EXDATE`, removing an existing override).

  Verify with tests that parse the output back: unknown properties (`VALARM`, `X-APPLE-*`) survive edits, a series shift moves every occurrence and keeps overrides, and an occurrence delete hides only that occurrence.

## 5. Settings, discovery state and handles

- [x] 5.1 Implement `src/settings.ts` (design D8):
  - load from `ctx.storage` key `settings` in `init` and mirror it in memory;
  - defaults on/on for unknown calendars;
  - resolve the default calendar, falling back to the first used, writable one in iCloud's order;
  - validate an update against the current discovery.

  Verify with `test/settings.test.ts`: the defaults; that settings survive a re-init of the test host; the fallback when the default is unused; that an unknown id or a read-only default is rejected.
- [x] 5.2 Implement `src/handles.ts` (design D3): short ids, an LRU with up to 1000 entries, a 2-hour TTL refreshed whenever an event is returned again, and an injectable clock. Verify with `test/handles.test.ts`: the same event gets the same id while it's live, an id expires after 2 hours without being returned, and an unknown id raises `UnknownEventError` asking to list again.

## 6. Read and create tools

- [x] 6.1 Implement `calendar_list_events` (spec "Listing events"):
  - the `from`/`to` defaults (7 days, or 365 with a query), dates in `to` covering the whole day, the 366-day limit, `to` after `from`;
  - the `query` word match on title, location and notes;
  - the `calendar` name filter, with an error listing the used calendars;
  - unused calendars skipped;
  - sorted by start, capped at 50 with `truncated` and the total.

  Verify with `test/tools.test.ts` against the fake fetch, one case per spec scenario plus each validation error.
- [x] 6.2 Implement `calendar_create_event` (spec "Creating events"): the default durations, the target calendar rules, `If-None-Match: *`, the `overlaps` from used calendars, the `say` text, and the handle for the new event. Verify in `tools.test.ts`: a simple create in the default calendar; an overlap reported while the event is still created; a weekly event with an end date; a read-only or unknown calendar creating nothing; an all-day event with an inclusive end.
- [x] 6.3 Extend the README's calendar section with example requests and the list/create behaviour. Verify that the examples match the tool parameters.

## 7. Previews, confirmation and invitations

- [ ] 7.1 Implement `src/tokens.ts` (design D4): random 6-character tokens, single use, expiring after 5 minutes (injectable clock), each holding the exact request, the ETag, the before/after summaries, the channel and the conversation id. Verify with `test/tokens.test.ts`: a token is used up after one use, an expired token is rejected, and an unknown token is rejected.
- [ ] 7.2 Implement `calendar_update_event` and `calendar_delete_event` (spec "Previewing edits and deletions"):
  - at least one field for an edit; an empty `location`/`notes` clears it; a new start keeps the duration;
  - `scope` required for recurring events; series date changes refused;
  - read-only events and invitations refused before a token is issued;
  - the preview contains `token`, `expiresInSeconds`, `before`, `after`, `overlaps` and the `instruction`.

  Verify in `tools.test.ts`: no write request is sent during a preview, plus one case per spec scenario.
- [ ] 7.3 Implement `calendar_confirm` (spec "Confirming a change"): replay the stored request with `If-Match`; on a 412 or 404, fetch the current version and fail with it; refresh the handle and trigger the agenda refresh on success. Verify in `tools.test.ts`: a confirmed edit, a reused token, a change made on the phone in the meantime (412 with the current version in the error), an occurrence delete, and a series delete.
- [ ] 7.4 Document the confirmation flow in the README (preview, read-back, confirm; invitations are read-only). Verify by reading it back against the spec.

## 8. Change log and undo

- [ ] 8.1 Add `src/schema.ts` migration 1 creating `calendar__changes` (design D6), and `src/changes.ts` to record entries (with source and conversation id), keep the newest 500, and list them. Verify with `test/changes.test.ts`: create, confirmed edit and delete are each logged with their before/after ICS and source; the 501st entry prunes the oldest; the conversation id is recorded when the call context has one.
- [ ] 8.2 Implement undo (D6), shared by the tool and the portal: delete for a create; `PUT before_ics` with `If-Match` for an edit or occurrence delete; `If-None-Match: *` for a series delete. It refuses with the current version when the event changed, records the undo row and sets `undone_by` in one transaction, and undo rows are never targets. Verify with tests for each action, plus "changed since" and "already undone".
- [ ] 8.3 Implement the `calendar_undo` tool: the most recent tool change from the last 24 hours that hasn't been undone, or "nothing to undo". Verify in `tools.test.ts` with the spec scenarios: undoing a deletion, nothing to undo, and changed since.

## 9. Agenda in the prompt

- [ ] 9.1 Implement the `calendar/refresh` job (design D7: `everyMs` 300000, `timeoutMs` 60000). It rediscovers calendars, fetches three local days for used calendars, keeps the previous cache and records the error on failure, is triggered from `init` and after each successful write, and makes no network call in `init` itself. Verify with `test/agenda.test.ts` via the test host's `runJob`: a success fills the cache, a failure keeps it and sets the status error, and a module whose fetch always fails still loads.
- [ ] 9.2 Implement the prompt provider (spec "Agenda in the prompt"): today and tomorrow worked out at render time; only `inAgenda` calendars; all-day events first; "nothing planned"; the fetch time stated when the cache is older than 15 minutes; "unavailable" before the first success; cut to 2000 characters with the number left out. Verify with the test host's rendered prompt context: the spec scenarios (present, midnight rollover, unreachable after an earlier success, never fetched), the cut-off, and an `inAgenda: false` calendar left out.
- [ ] 9.3 Add the agenda behaviour and its privacy note (it's in every prompt; limit it with "in agenda") to the README. Verify by reading it back.

## 10. Portal routes

- [ ] 10.1 Implement `src/routes.ts` (spec "Portal routes"): `GET status`, `PUT settings`, `GET agenda`, `GET changes` (`limit` default 50, max 200), `POST changes/:id/undo` (409 with the reason and the current version), and `POST refresh`. Verify with `test/routes.test.ts` through `host.request`: every route; the 400s for an unknown id and a read-only default; the portal undo logged with source `portal`; and that no response body contains the password.

## 11. Portal page

- [ ] 11.1 Add a `calendar` icon to `packages/portal-ui/src/components/Icon.vue`, and `src/ui/index.ts` with `defineModuleUi` (nav "Calendar", order 30, one route). Verify that `pnpm --filter @friday/portal build` includes the module (`scripts/gen-modules.mjs` picks it up).
- [ ] 11.2 Build `src/ui/CalendarPage.vue` with the tabs (design D11):
  - **Overview:** status with a refresh button; the calendars with colour, a read-only badge, `use`/`inAgenda` toggles and a default radio button; the agenda preview.
  - **Changes:** the log, with Undo where possible and errors shown inline.

  Put any pure helpers in `src/ui/lib` and test them in `test/ui-lib.test.ts`, like brain does. Verify with the portal build, and in a browser against a dev server on free ports (`FRIDAY_PORT=8081`), using the fake or real account: toggling a setting saves and changes the agenda preview after a refresh, and Undo marks the entry as undone. Stop the dev server afterwards.
- [ ] 11.3 Document `/m/calendar` in the README and extend the `openspec/config.yaml` context with the calendar module: id, tools, confirmation and undo, agenda job, settings, and routes. Verify by reading both back.

## 12. Integration

- [ ] 12.1 Do a manual end-to-end check against the user's real iCloud account with an app-specific password, in a dev server on free ports:
  - the calendars are discovered;
  - "what's on tomorrow" in chat matches the Calendar app;
  - create, then a previewed and confirmed move, then delete one occurrence of a test recurring event, then undo; each shows up on the phone;
  - the agenda preview matches.

  Clean up the test events afterwards and record any iCloud quirk found in design.md.
- [ ] 12.2 Run the quality gate in the worktree: `pnpm -r build && pnpm -r typecheck && pnpm -r test`, then `/opsx:verify icloud-calendar`, then `/code-review`, then `/security-review` (this change adds secrets, outbound auth and HTTP routes). Fix what they confirm and report the results.
