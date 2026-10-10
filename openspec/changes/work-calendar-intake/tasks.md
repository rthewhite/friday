# Tasks

## 1. Optional sources and the Work calendar entry

- [x] 1.1 Make the four keys optional in the manifest and check in `init` that at least one pair is complete. Add `INTAKE_URL` (plain) and `INTAKE_KEY` (secret) with descriptions, and update the module description (design D2). Verify in `test/module.test.ts`:
  - with no keys, the module fails naming the missing keys and registers no tools;
  - with only the intake keys, it loads with all six tools;
  - with only the iCloud keys, it behaves as before.
- [x] 1.2 Add `source` to `CalendarInfo`. Make `account()` return the iCloud calendars (when configured, recording rather than throwing their failure) followed by the Work calendar: id `intake-work`, `Work`, or `Work (Outlook)` on a clash, not writable (design D1). Keep per-source status for iCloud and Work, with the missing key named. Verify in `test/settings.test.ts` and a new `test/work.test.ts`:
  - the Work calendar is listed with `writable: false` with and without iCloud;
  - the name clash;
  - Work can't be the default (`PUT settings` returns 400);
  - when iCloud discovery fails, Work is still listed.
- [x] 1.3 Add `.env.example` entries for `INTAKE_URL` and `INTAKE_KEY`, commented out, with the one-consumer warning (design D9). Verify that the keys match the manifest.
- [x] 1.4 Run `pnpm --filter @friday/module-calendar test` and `typecheck`.

## 2. Intake client and snapshot

- [x] 2.1 Implement `src/intake.ts` (design D3):
  - a `POST` with the bearer key and `{"subject":"calendar"}`;
  - `redirect: "manual"`, with a 3xx as an error;
  - a 30 s timeout;
  - 401/403 as `IntakeRejectedError`, other failures as `UpstreamError`, never containing the key.

  Add a fake intake (`test/fake-intake.ts`) that queues messages and removes them when read. Verify with `test/intake.test.ts`:
  - the request method, headers and body;
  - an empty queue gives `[]`;
  - a 401 message names `INTAKE_KEY` without its value;
  - a redirect is not followed and no request reaches the redirect target;
  - a timeout.
- [x] 2.2 Implement `WorkSource` in `src/work.ts` (design D4):
  - pick the newest usable message newer than the stored snapshot;
  - validate items (offset required), counting the skipped ones;
  - `ctx.storage.set("work-snapshot")` before the in-memory swap;
  - load the snapshot in `init`;
  - warn at exactly 256 items.

  Add fixtures in `test/fixtures/intake/`, shaped like the real payload with made-up titles: a V3 delivery, an old-format delivery and an empty queue. Verify in `test/work.test.ts` with the spec scenarios: new snapshot, nothing waiting, several deliveries queued, newest unusable, old-format events, restart (a new module instance on the same storage), and the 256 warning.
- [x] 2.3 Implement `toOccurrence` and `workLocation` (design D5):
  - offsets to instants;
  - all-day dates taken as written;
  - stripping the cancelled prefix (`Geannuleerd`, `Canceled`, `Cancelled`);
  - `showAs` to status;
  - online, rooms and the underscore;
  - ids from title, start and end.

  Verify in `test/work.test.ts` with the "Work events" scenarios: timed in Amsterdam, all-day in `America/New_York`, cancelled, an online meeting with rooms, a meeting link, and an id that survives a new snapshot. Also add cases for `Microsoft Teams Meeting` alone, an empty location, and `__Room`.
- [x] 2.4 Run `pnpm --filter @friday/module-calendar test` and `typecheck`.

## 3. Tools across both sources

- [ ] 3.1 Split `occurrences()` by source: Work from the snapshot, iCloud as today. An iCloud failure becomes a note when Work is also asked for (design D1). Add `status` to `Occurrence` and `EventView`. Verify in `test/tools.test.ts`:
  - `calendar_list_events` returns work and iCloud events merged by start, with `status` and `location` mapped;
  - "iCloud down" returns the work events with the note;
  - a `calendar: "Work"` filter works with iCloud down.
- [ ] 3.2 Add the coverage note to `list()` (design D6): no snapshot yet, or a range outside one month back to six months ahead of `received_at`. Verify with the "Search past the work window" scenario, a range inside the window (no note), and a listing that leaves out the Work calendar (no note).
- [ ] 3.3 Count work meetings in `overlaps()`, except those with status `free` or `cancelled`. Verify with the "Work meeting clash" and "Cancelled meeting ignored" scenarios, and creating an event with `calendar: "Work"` (refused as read-only).
- [ ] 3.4 Refuse Work events in `readOnlyReason()` and in `current()` before any iCloud request. Verify with the "Work meeting" scenario for update and delete: no token is issued, and the fake iCloud sees no request.
- [ ] 3.5 Run `pnpm --filter @friday/module-calendar test` and `typecheck`.

## 4. Refresh job and agenda

- [ ] 4.1 Rework `Agenda.refresh()` and the job (design D7):
  - the intake poll and the iCloud fetch each fail on their own;
  - skip a source that isn't configured;
  - the job summary names both;
  - the job fails only when every configured source failed.

  Verify in `test/agenda.test.ts` through `runJob`:
  - a failed intake poll still refreshes iCloud, and the other way round;
  - an intake-only module refreshes without iCloud requests;
  - the summary text.
- [ ] 4.2 Rework `render()`:
  - Work events come from the snapshot at render time;
  - a neutral header;
  - ` (<status>)` and ` [<calendar>]` when more than one calendar is in the agenda;
  - per-source notes (iCloud unavailable or stale, work unavailable or older than 3 h);
  - nothing about a source that isn't configured.

  Verify with the spec scenarios: agenda present, midnight rollover, iCloud unreachable, never fetched (work still listed), work and home together, work snapshot old, intake not configured. Also verify that the 2000-character cut still holds with calendar labels.
- [ ] 4.3 Run `pnpm --filter @friday/module-calendar test` and `typecheck`.

## 5. Portal

- [ ] 5.1 Extend `GET status` and `POST refresh` (design D8): `icloud.configured`/`missing`, the `work` object, and `source` per calendar. Verify in `test/routes.test.ts`:
  - the "Work status" scenario;
  - `POST refresh` drains a queued fake-intake message;
  - with only the intake configured, the status has no username and `icloud.configured: false`;
  - no response body contains `INTAKE_KEY` or the iCloud password.
- [ ] 5.2 Update `CalendarPage.vue` (design D8):
  - two connection rows (iCloud and Work), with the Work row showing last update, events, coverage, last poll and error;
  - an `Outlook` badge on the Work calendar;
  - "not configured" states.

  Put the time and coverage text helpers in `src/ui/lib/calendar.ts`, with tests in `test/ui-lib.test.ts`. Verify with `pnpm --filter @friday/portal build`. Then check in a browser against a dev server on free ports (`FRIDAY_PORT=8081 FRIDAY_CORE_URL=http://localhost:8081 pnpm dev`), with only the iCloud keys in `.env`, so the intake isn't configured and the "not configured" Work row shows. Stop the dev server afterwards.
- [ ] 5.3 Run `pnpm --filter @friday/module-calendar test` and `typecheck`, and `pnpm --filter @friday/portal typecheck`.

## 6. Deploy and docs

- [ ] 6.1 Add `- secretRef: { name: intake }` under `envFrom` in `deploy/k8s.yaml`, and add `INTAKE_*` to the comment that lists module keys. Verify with `kubectl apply --dry-run=client -f deploy/k8s.yaml`, or a YAML parse if no kubectl is available locally.
- [ ] 6.2 README "Calendar" section:
  - the Work calendar: where it comes from, read-only, hourly, about 5 minutes of delay, covers 1 month back to 6 months ahead;
  - the destructive read and "configure the intake in one place only";
  - how cancelled, tentative and online meetings show;
  - iCloud now being optional.

  Update the `calendar` part of the `openspec/config.yaml` context (sources, `intake.ts`/`work.ts`, `work-snapshot` in `ctx.storage`, coverage). Verify by reading both back against the spec.

## 7. Integration

- [ ] 7.1 Do an end-to-end check on the homelab after deploying the branch image, with the user's approval to deploy:
  - within 5 minutes of the hourly push, `/m/calendar` shows the Work calendar with a `received_at` and an event count of about 218;
  - in chat, "what meetings do I have on Monday" matches Outlook (times in Amsterdam, cancelled marked);
  - "add a dentist appointment during my standup" reports the standup as an overlap (then undo it);
  - the prompt agenda shows `[Work]` labels.

  Record any payload quirk found in design.md.
- [ ] 7.2 Run the quality gate in the worktree: `pnpm -r build && pnpm -r typecheck && pnpm -r test`, then `/opsx:verify work-calendar-intake`, then `/code-review`, then `/security-review` (this change adds a secret, outbound authenticated requests and route fields). Fix what they confirm and report the results.
