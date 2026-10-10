# Design

## Context

See proposal.md for the motivation and specs/calendar/spec.md for the behaviour. What shapes the approach:

- **The intake.** It is a small homelab service at `192.168.50.10:8081`, reachable from the cluster but not from the laptop. `POST /out` with a bearer key returns `{"messages":[{id, subject, sender, received_at, content}]}` and **deletes** what it returns. With nothing waiting it returns `200 {"messages":[]}`.
  - We checked this on 2026-10-10: five deliveries were queued. The first four came from the old "Get events" flow (offset-less times, series masters, capped at 256 items). The newest came from the current "Get calendar view of events (V3)" flow: 218 expanded occurrences, offsets `+00:00`, a window of 1 month back and 6 months ahead.
  - The flow runs hourly and sends no stable event ids and no cancelled flag. Cancelled meetings keep a "Geannuleerd: " title with `showAs: free`. All-day events run from midnight UTC to midnight UTC.
- **The calendar module is built around CalDAV.**
  - `CalendarService.occurrences()` queries every calendar through `client.query`.
  - `Found` carries a `CalendarObject` (url, etag, ics).
  - `current()` re-fetches from iCloud before any preview.
  - `Agenda.refresh()` starts with `service.account(true)` and fails as a whole when iCloud does.
  - The manifest marks both iCloud keys `required`, so the module host refuses to load without them.
- **Prompt providers are synchronous.** `ctx.storage` is async, so anything the agenda shows has to be held in memory as well.

## Goals / Non-Goals

**Goals:**
- The Work calendar is one more `CalendarInfo` everywhere the existing code iterates calendars: settings, list, overlaps, agenda and portal. This avoids a second set of tools and a second prompt section.
- Each source fails on its own. A dead iCloud never hides work meetings, and a dead intake never hides iCloud.
- The destructive read can lose at most the one snapshot that was in flight, and the next hourly push restores it.
- The CalDAV paths (writes, undo, previews) stay as they are.

**Non-Goals:**
- A general "external read-only calendar" plugin system. One intake source is enough, and the shape can be generalised if a second one appears.
- Diffing snapshots, or a history of the work calendar.
- Reading other intake subjects, or acknowledging and re-queueing on the intake side.

## Decisions

### D1. The Work calendar is a `CalendarInfo` with a source tag

`CalendarInfo` gains `source: "icloud" | "intake"`. The intake calendar has `id: "intake-work"`, `url: "intake:work"`, `name: "Work"` (or `"Work (Outlook)"` on a name clash), no colour, and `writable: false`.

`CalendarService.account()` returns the iCloud calendars, when iCloud is configured and discovery works, followed by the Work calendar, when the intake is configured. Since it no longer throws when iCloud fails, it records the iCloud error in a per-source status. `Settings` needs no change, because it is keyed by id and `defaultCalendar` already skips non-writable calendars.

`occurrences(calendars, from, to)` splits by source:
- iCloud calendars go through `client.query` as today, wrapped so that a failure is returned as `icloudError` instead of thrown when the Work calendar is also asked for;
- the Work calendar reads from the in-memory snapshot (D4).

Work `Found`s carry a synthetic `CalendarObject`:
- `url: intake:work#<key>`, where `<key>` is the SHA-256 of `title|startMs|endMs`, cut short;
- `etag: ""`;
- `ics: ""`.

`EventHandles` keys on `objectUrl#recurrenceKey`, so an unchanged meeting keeps its id across hourly snapshots without touching handles.ts.

`readOnlyReason()` returns the Outlook reason for `source === "intake"` before the invitation check. `current()` checks the handle's calendar source **before** `client.get`, so a work id never reaches iCloud.

*Alternative:* a separate `work-calendar` module with its own `work_calendar_list` tool and prompt section. That's simpler to build, but the user asks "am I free at 3?" across both calendars. Two tools would make the model join them, overlap checks on create would miss meetings, and the portal would get a second calendar page. Rejected.

*Alternative:* turn the snapshot into ICS and push it through the existing `expand()` path. That reuses the most code, but it would mean producing VTIMEZONE and VEVENTs only to parse them straight back, and the all-day date rule (D5) would get lost in the conversion. Rejected.

### D2. Optional keys, checked in `init`

All four keys are declared without `required`. `init` checks that at least one pair is complete, and otherwise throws `calendar: configure ICLOUD_USERNAME and ICLOUD_APP_PASSWORD, or INTAKE_URL and INTAKE_KEY` (naming the unset ones). After that, each source checks its own pair on every request or poll through `ctx.config.get`. A source missing a key is "not configured" in the status, with the missing key named, and adds no calendars. This keeps the existing "saved later works without a reload" behaviour for both sources.

The CalDAV client's `credentials()` callback stays as it is. It is simply not called when iCloud isn't configured.

### D3. Intake client (`src/intake.ts`)

`IntakeClient.poll(signal)` uses an injectable `fetch`, like the CalDAV client.
- **The request:** `POST` to `INTAKE_URL` with `Authorization: Bearer`, `Content-Type: application/json` and body `{"subject":"calendar"}`. It sets `redirect: "manual"` (a 3xx is an error), and a 30-second timeout through `AbortSignal.any([signal, AbortSignal.timeout(30_000)])`.
- **Errors:** 401 or 403 becomes an `IntakeRejectedError` ("the intake refused INTAKE_KEY"). Other non-2xx answers and invalid JSON become an `UpstreamError` with the status only. Neither error includes the URL's query or the key. Plain `http` is allowed, since the intake is on the LAN.
- **Result:** the parsed `messages` array. Picking and validating a message is left to D4, which keeps the client a dumb transport and makes D4 testable without `fetch`.

The poll runs inside the `calendar/refresh` job, so it runs every 5 minutes and after portal refreshes. It is not triggered after calendar writes, since nothing Friday writes can change the work calendar.

### D4. Snapshot: pick, validate, persist, then use

`WorkSource` in `src/work.ts` owns the snapshot.

```
poll() -> messages
  |
  |-- []                                    -> keep, lastPoll = ok ("nothing new")
  |-- for m in messages sorted by received_at desc (array index breaks ties: later wins):
  |     skip if m.subject != "calendar" or received_at <= stored.receivedAt
  |     valid = content.filter(isValidItem)
  |     usable = Array.isArray(content) && (content.length == 0 || valid.length > 0)
  |     if usable: candidate = m; break
  |-- no candidate -> keep, lastPoll = failed (why the newest was unusable)
  `-- candidate   -> await ctx.storage.set("work-snapshot", {...}) THEN this.snapshot = ...
```

- **What's stored:** `{ messageId, receivedAt, storedAt, items, skipped }`, where `items` are the valid raw items. Storing the raw items rather than mapped events means a fix to the mapping (D5) applies to the stored snapshot straight away, without waiting for the next push. About 70 KB of JSON, so `ctx.storage` (module_kv) is enough and no migration is needed.
- **Startup:** `init` loads the snapshot before the first prompt is built, so the agenda has work events immediately after a restart.
- **Valid items:** `isValidItem` needs a string `subject`, a boolean `isAllDay`, and `start`/`end` that match `YYYY-MM-DDTHH:MM:SS(.fraction)?(Z|±HH:MM)` and parse. `end` must not be before `start`. The old-format items fail on the offset check.
- **256 items:** a warning in the log and in `status.work.warning`, with the event count. No other behaviour changes.

Persisting before the in-memory swap means a crash between the two leaves the store ahead of memory, which the next start loads. A crash *between the POST and the store* loses that delivery, and the next hourly push replaces it.

### D5. Mapping to `Occurrence` (`src/work.ts`)

`toOccurrence(item, zone)`:

- **Timed events:** `startMs`/`endMs` come from `Date.parse` of the offset strings.
- **All-day events:** `startDate`/`endDate` are the first 10 characters of `start`/`end`, taken as written (an exclusive end, the same convention as iCloud all-day spans). `endDate` is raised to `startDate + 1` if it isn't later. `startMs`/`endMs` are `startOfLocalDay` of those dates in the household zone, so range filtering and the agenda's day logic work unchanged.
- **Title and status:** `/^(geannuleerd|canceled|cancelled)\s*:\s*/i` is stripped and sets `status: "cancelled"`. Otherwise the status comes from `showAs`: `tentative`, `free`, and `oof` mapped to `out of office`.
- **Location:** `workLocation()` splits on `;` and trims. A part that matches `/^https?:\/\//i` or `/^microsoft teams meeting$/i` becomes the single leading `online`. Other parts lose a leading `_` (all of them, so `__Room` becomes `Room`) and empty ones are dropped. The result is joined with `", "`, or `undefined` when empty.
- **Fixed fields:** `uid` is the D1 key, `recurring` is false, and `organizer` is kept but not shown.

`Occurrence` gains an optional `status`. `view()` copies it to `EventView.status`. `overlaps()` drops events with the status `free` or `cancelled`, as well as all-day events as today.

### D6. Coverage note

The flow's window isn't in the payload. `coverage(snapshot, zone)` therefore computes it from `received_at`: the local date one calendar month before it, through the local date six calendar months after it, clamped to the end of the month when needed. `list()` adds `coverage` when the Work calendar is among the queried calendars and the range reaches outside that window, or when there is no snapshot yet. The text is, for example: "The Work calendar only covers 10 Sep 2026 to 10 Apr 2027; there may be work events outside that." The window is a constant in `work.ts` (`COVERAGE = { monthsBack: 1, monthsAhead: 6 }`), with a comment saying it mirrors the Power Automate flow. The status route shows it, so a mismatch after someone changes the flow is visible in the portal.

*Alternative:* derive the window from the earliest and latest event. That underestimates it on quiet weeks and would claim gaps that aren't there. Rejected.

### D7. Agenda: independent sources, per-source notes

`Agenda.refresh()` becomes three steps that can each fail on their own:
1. poll the intake when it is configured (D4), recording the error;
2. iCloud discovery and the three-day fetch when iCloud is configured, as today, recording the error;
3. fill the cache.

The job's summary names both, for example `4 events in 2 calendars; work: 218 events (received 14:45)`. The job fails, so that Settings > Background jobs shows it, only when every configured source failed.

`render()` changes in five ways:
- It takes the iCloud events from the cache as today, and the Work events from the snapshot for the two days at render time, so a new snapshot shows in the next prompt without a re-fetch.
- The header becomes "The user's calendars for today and tomorrow …".
- Each line gets ` (<status>)` when there is one, and ` [<calendar name>]` when more than one calendar is used with `inAgenda` on. The calendar names cost a few characters per line, and the 2000-character cap and the cut stay as they are.
- The notes follow the spec, in this order: iCloud unavailable or stale, then work unavailable or stale (`received_at` more than 3 hours old).
- The "never fetched" text no longer claims the whole calendar is unavailable when the Work events are there.

### D8. Status route and page

`status()` adds `icloud: { configured, missing? }` next to the existing iCloud fields, which stay for compatibility. It also adds:

```
work: {
  configured, missing?,
  receivedAt, events, skipped,
  coverage: { from, to },
  polledAt, ok, error?, warning?
}
```

and `source` per calendar. `POST refresh` polls too.

On the page, the Overview's connection card becomes two rows, iCloud and Work, each with a `StatusDot`. The Work calendar row in the calendar list gets an `Outlook` badge next to `read-only`. There are no new components.

### D9. Deploy and the one-consumer rule

`deploy/k8s.yaml` adds a second `envFrom` entry, `secretRef: { name: intake }`, under `friday-secrets`.

The key operating rule is that **only one Friday may poll the intake**, because a second one silently steals the snapshots. Three things enforce it:
- The keys are only in the k8s Secret.
- `.env.example` lists them commented out, with the warning.
- The README says the same.

The laptop can't reach `192.168.50.10` today, which helps but isn't something to rely on.

## Risks / Trade-offs

- **[A second consumer drains the intake]** → Configure it in one place only (D9). The portal shows the last `received_at`, so a Friday that never gets snapshots is visible. The agenda says the work calendar is out of date after 3 hours.
- **[The flow changes shape, for example times without an offset again]** → Items are validated, and a fully invalid delivery keeps the previous snapshot and reports why. It never empties the calendar.
- **[Power Automate stops running (token expiry, licence)]** → The snapshot ages visibly: the agenda note after 3 hours, and the status in the portal. Friday keeps answering from the last snapshot rather than claiming free time.
- **[A cancelled meeting in another language, for example "Abgesagt:"]** → It shows up as `free`, because Outlook sets `showAs: free` on cancellations. So it never counts as an overlap. It just isn't labelled cancelled. Adding a prefix later is a one-line change.
- **[An all-day event created in a far-off zone]** → Its date part might be a day off. We accept that: the real data has midnight-UTC all-day events, and taking the date as written is right for those.
- **[Work meeting titles go to Gemini in every prompt]** → This is the same as the iCloud agenda today. `inAgenda` off for Work keeps them out of the prompt while still answering tool queries.
- **[Ids based on title, start and end]** → A meeting that is renamed or moved gets a new id after the next snapshot. That's fine, because edits are refused anyway, and the id is only needed for listing.

## Migration Plan

1. Merge. `deploy/k8s.yaml` gains `envFrom: secretRef: intake`, and the Secret already exists in the `friday` namespace.
2. The rollout restarts the pod. The module loads with both sources, and the first refresh polls the intake. Anything queued since the flow started is picked up (newest wins). If nothing is queued, the first snapshot arrives with the next hourly push.
3. **Rollback:** revert the deploy. The stored `work-snapshot` key is ignored by the old code. The intake then fills up again, and the next consumer only takes the newest.
