# Design

## Context

Alerts live in core (`packages/core/src/alerts/`): `AlertStore` keeps rows in the `alerts` table (migration 8, `kind TEXT`), `AlertService` plans one wake-up timer and rings devices over their control connection, and `tools.ts` registers the core-owned voice tools. A timer's due time is `now + seconds`. Nothing turns a clock time into an instant, so the model had to do that sum. On 13 October it did it from a UTC clock (see proposal.md, Why). The household zone is `FRIDAY_TIMEZONE`, already passed to the tools and the service as `timezone()`. `@friday/sdk`'s `parseDateTime(value, zone)` reads an offset-less local date-time in a zone and rejects dates that don't exist, but it maps a wall-clock time skipped by DST to a shifted instant without saying so.

The ring policy is one set of numbers for every alert: `rings` (5), `ringIntervalMs` (60 s), `graceMs` (10 min). The firmware's local ring stops after its own `ring_limit` (5 min default) and reports `unanswered`, which today makes the alert `missed`.

`device-alerts-and-timers` is merged but not archived (hardware tests outstanding), so the `alerts` spec this change modifies exists only as that change's delta.

## Goals / Non-Goals

**Goals:**
- The model passes the clock time the user said. Core works out the instant in the household zone, including DST.
- Every reply about an alert can quote one string core produced (`when`), so "I set it for 07:30" can only come from a tool result that says 07:30.
- Alarms ring for a wake-up-sized window without firmware changes.

**Non-Goals:**
- Repeating alarms. Each alarm is one row with one due time; a later change can add a rule column and re-arm after each ring.
- Changing `snooze_alert` or the alert-session flow: an alarm is announced and answered exactly like a timer.
- Changing the alerts table: no migration.

## Decisions

### 1. Alarms are a kind, not a separate subsystem

`AlertKind` becomes `"timer" | "alarm"`. Everything that exists (store, rings, claims, snooze, API, Alerts page) works for both. The ring policy is the only per-kind behaviour, so `AlertService` gets a `policy(kind)` lookup: `{ maxRings: rings | Infinity, windowMs: graceMs | alarmWindowMs }`. `tick()`'s deadline, `plan()` and `unanswered()` read it instead of `opts.graceMs`/`opts.rings`.

*Alternative*: a separate alarm table and service. It would have duplicated the ring and claim logic for a difference of two numbers.

### 2. Alarm window replaces the grace limit and the ring cap

For an alarm, `windowMs = FRIDAY_ALARM_RING_MINUTES × 60 000` (default 30) does both jobs: the last moment a first ring may start after an outage, and the end of re-ringing. One number is easier to explain ("Friday tries to wake you for half an hour") than a grace limit plus a ring count. `deviceReport("unanswered")` for an alarm calls the same path as an unanswered session: clear `local`, count the ring, set `nextRingAt = now + interval`. The existing deadline check then makes it `missed` once the window has passed. Timers keep today's behaviour exactly.

*Alternative*: send the firmware a longer `ring_limit` per ring. Rejected: it needs a firmware change on both devices, and the Voice PE hasn't been flashed with the alerts firmware yet.

### 3. Resolving a time of day: `alarmTime(time, date | undefined, now, zone)`

A new pure module `alerts/clock-time.ts`:
- validates `HH:MM` and `YYYY-MM-DD` strictly,
- picks the date: the given one, else today's local date (`localDate`), moving to tomorrow when that instant is not after `now`,
- builds the instant with `parseDateTime(`${date}T${time}`, zone)`, then **checks the round trip**: formatting the instant back in `zone` must give the same `HH:MM`. A mismatch means the time was skipped by summer time, which is an error. For a time that occurs twice, `parseDateTime`'s first guess is the earlier offset. A test pins this for Europe/Amsterdam's last Sunday of October,
- refuses a date in the past or more than 7 local days ahead.

It returns `{ instant } | { error }`. `change_alert` uses it too.

*Alternative*: let Gemini pass an ISO instant. That just moves the sum from seconds to offsets, which is the mistake we're fixing.

### 4. One `when` formatter, in the alert's language

`alerts/when.ts`: `spokenWhen(due, now, zone, language)` builds the phrase from `Intl.DateTimeFormat` parts (`nl-NL` / `en-GB`, weekday + day + month) plus a fixed `HH:MM`, with "vandaag/today" and "morgen/tomorrow" by comparing local dates. Every tool result goes through one `view(alert)` that adds `when`, so `list_alerts`, errors listing alerts, `set_*` and `change_alert` can't drift apart. The `due` `HH:MM` field stays for the model's own matching (`due` selector).

### 5. Tool set and selection

Six core tools: `set_timer`, `set_alarm`, `list_alerts`, `change_alert`, `cancel_alert`, `snooze_alert`. The tool count goes from 4 to 6. One `pick(args)` implements the selection rule shared by `change_alert` and `cancel_alert`:
- `id` → that alert,
- else filter on `label` (case-insensitive), `due` (local `HH:MM` of `dueAt`) and `kind`, combined with AND,
- exactly one match → act, else the error with every active alert's view.

`change_alert` refuses `ringing` alerts, since the service may have a ring in flight or a claim open for them. Snooze is the tool for that. A move goes through a new `AlertService.reschedule(id, dueAt)`: `store.update` with `state: scheduled, dueAt, nextRingAt: dueAt, rings: 0, local: false`, then a log line and `tick()`.

`set_alarm` returns `others` (the device's other scheduled alarms) and de-duplicates an identical due instant on the same device. Both are cheap guards against the "set it again" pattern from 13 October.

### 6. Prompt and descriptions say the same thing

The voice prompt (`prompts.voice` in `config.ts`) gets a short "Timers and alarms" paragraph with the four rules in the `voice-session` spec. Each tool description repeats the rule for itself (the "when" sentence, `set_alarm` vs `set_timer`, "correct with `change_alert`"). Gemini Live weighs tool descriptions at call time, and the prompt covers the confirmation case, where no tool would otherwise be called.

### 7. Opening turn for an alarm

`opening.ts` describes an alarm as `the alarm "wekker" for 07:30` (plus "N minutes ago" when late), not as a duration with "set at". A snoozed alarm keeps today's snooze wording.

## Risks / Trade-offs

- [Gemini still calls `set_timer` for a clock time] → the `set_timer` and `set_alarm` descriptions and the prompt each say so. The `when` in the result shows the real time, and the prompt tells the model to repeat it, so a wrong pick is said out loud instead of hidden.
- [30 minutes of ringing every minute is loud if nobody is home] → it's configurable, the button or "stop" ends it, and the portal can cancel it. Timers are unchanged.
- [Renaming `list_timers`/`cancel_timer` breaks conversation replay in chat] → those tools are voice-only, and voice sessions don't replay history. Old transcripts keep the old names as plain text.
- [`parseDateTime` behaviour around DST] → covered by the round-trip check and explicit tests for both transitions in Europe/Amsterdam.
- [Archive order] → this change can't be archived before `device-alerts-and-timers`. Its delta modifies requirements that only exist there. The apply and merge can still go first.

## Migration Plan

No data migration. Existing timer rows keep working. After a rollback, an older image still rings rows with `kind = 'alarm'`, but with the timer policy (5 rings, 10-minute grace), and its `list_timers`/`cancel_timer` can't see them. The portal's Alerts page can still cancel them. `FRIDAY_ALARM_RING_MINUTES` is optional, documented in `.env.example`, and not set in `deploy/k8s.yaml`.
