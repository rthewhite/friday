# Proposal

## Why

Friday only knows the user's iCloud calendar, so it can't answer "when is my next standup?" or "am I free at 3 tomorrow?" for work. It also creates personal events right on top of meetings without noticing. The work calendar is in Outlook, behind an employer tenant that Friday can't reach directly. A Power Automate flow now sends a full copy of it every hour to the homelab intake service, which Friday can read from.

## What Changes

- The `calendar` module gets a second, read-only source: the **Work** calendar, read from the intake.
  - `INTAKE_URL` (plain) and `INTAKE_KEY` (secret) are new optional config keys. In k8s they come from the existing `intake` Secret.
  - Friday polls `POST $INTAKE_URL` with `{"subject":"calendar"}` from the `calendar/refresh` job. A read **removes** what it returns, so Friday keeps the newest delivered snapshot in friday.db.
  - The newest delivery always replaces the whole snapshot. When nothing is waiting, the stored snapshot stays as it is.
- Work events are mapped for voice:
  - times are shown in the household zone, and all-day events keep their own dates;
  - "Geannuleerd: " and "Canceled: " meetings are marked cancelled;
  - `showAs` free and tentative are respected;
  - online-meeting URLs and "Microsoft Teams Meeting" become "online", while room names stay, without their leading underscore.
- The Work calendar is one more calendar in the existing tools, settings, agenda and portal page:
  - `calendar_list_events` returns its events;
  - `calendar_list_events` also says when the asked range goes past what the flow sends (1 month back, 6 months ahead);
  - creating an event reports overlapping work meetings;
  - edits and deletions are refused with "change it in Outlook".
- **BREAKING (config):** `ICLOUD_USERNAME` and `ICLOUD_APP_PASSWORD` are no longer required on their own. The module now needs at least one complete source (iCloud or intake), and fails to load naming the missing keys when it has neither. Existing deployments with iCloud set keep working unchanged.
- The agenda in the prompt is no longer worded as iCloud-only. It says per source when that source is unavailable or out of date, and it names the calendar of each event when more than one calendar is shown.
- The portal Overview shows the Work calendar's state: last delivery, number of events, and last poll and error.

Out of scope:
- writing to the work calendar;
- attendees, organizer details and meeting bodies (not in the payload);
- other intake subjects;
- detecting what changed between snapshots (the payload has no stable ids).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `calendar`: the module gets a second, read-only source (the intake work calendar), with its own requirements for polling, persistence, validation and mapping. Requirements change for:
  - credentials (each source is optional, but at least one is needed);
  - discovery (the Work calendar is listed);
  - event fields (meeting status);
  - listing (a coverage note);
  - overlaps (free and cancelled events don't count);
  - read-only events;
  - the agenda;
  - the portal routes and page.

## Impact

- **Code:** `modules/calendar/src`, with a new intake client and work source (`intake.ts`, `work.ts`), plus changes to:
  - `index.ts` (manifest, init check);
  - `service.ts` (calendars from both sources, work occurrences, read-only refusal before any iCloud request);
  - `agenda.ts` (sources refreshed independently, per-source notes);
  - `routes.ts` (status);
  - `ui/CalendarPage.vue`;
  - `format.ts` (location mapping).

  Tests go in `modules/calendar/test`, with a fake intake and fixtures based on the real payload shape.
- **Storage:** the snapshot is stored in `ctx.storage` (`work-snapshot`). No migration.
- **Network:** outbound HTTP from the pod to `192.168.50.10:8081` (the intake). The bearer key is sent only to `INTAKE_URL`, and redirects are refused.
- **Deploy:** `deploy/k8s.yaml` gets `envFrom: - secretRef: name: intake`.
- **Docs:**
  - README "Calendar" section: the work calendar, the destructive read, and "configure the intake in one place only";
  - `.env.example`: the two keys, commented out, with that warning;
  - the `calendar` context in `openspec/config.yaml`.
- **Other changes in flight:** `device-alerts-and-timers` is merged but not archived yet. It doesn't touch `modules/calendar`.
