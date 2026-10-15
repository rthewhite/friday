# Tasks

## 1. Clock time and spoken due time

- [x] 1.1 Add `alerts/clock-time.ts` with `alarmTime(time, date, now, zone)`: strict `HH:MM`/`YYYY-MM-DD`, next occurrence without a date, the 7-day limit, the round-trip check that refuses a time skipped by summer time, the earlier instant for a time that occurs twice. Verify with `packages/core/test/alert-clock-time.test.ts`: 23:41 → 07:30 the next day in Europe/Amsterdam (not UTC), later today, already passed today, a given date, past and day 8 refused, bad formats, both DST transitions of 2026 (29 March 02:30 refused, 25 October 02:30 the first one)
- [x] 1.2 Add `alerts/when.ts` with `spokenWhen(due, now, zone, language)` for today / tomorrow / later in `nl` and `en`. Verify with `packages/core/test/alert-when.test.ts`: `morgen, woensdag 14 oktober, om 07:30`, `today at 12:05`, `Friday 16 October at 07:30`, and a 05:30 UTC instant in summer time naming 07:30

## 2. Alarm kind and ring policy

- [x] 2.1 Make `AlertKind` `timer | alarm`, add `FRIDAY_ALARM_RING_MINUTES` (default 30) to `alertSettings`, and pass it to `AlertService` from `server.ts`. Verify with `alert-settings.test.ts` (default, env value, invalid falls back, documented in `.env.example`) and `pnpm --filter @friday/core typecheck`
- [x] 2.2 Give `AlertService` a per-kind policy: alarms ignore `rings`, and their window replaces `graceMs` for the first ring after an outage, for re-ringing and for a snoozed alarm (counted from the new due time). Verify with `alert-service.test.ts`: an alarm keeps ringing past the fifth unanswered ring, is acknowledged on a ring at +10 min, is `missed` once +30 min passes with no ring in progress, rings at once when started at +15 min, and the existing timer tests still pass unchanged
- [x] 2.3 Make a device's `unanswered` report for an alarm within its window count as an unanswered ring (clear `local`, ring again after the interval) instead of `missed`. Verify with `alert-service.test.ts`: a local ring that runs out at +5 min is followed by a `ring` a minute later, an alarm whose local ring runs out after its window is `missed`, a timer's local ring that runs out is still `missed`
- [x] 2.4 Add `AlertService.reschedule(id, dueAt)` (scheduled only; back to `scheduled` with `rings: 0`, `local: false`, `nextRingAt = dueAt`, re-plan), throwing `AlertNotFound` / `AlertConflict` for unknown or not-scheduled alerts. Verify with `alert-service.test.ts`: a moved alert rings at its new time and not at the old one, and a ringing alert is refused
- [x] 2.5 Describe an alarm in `opening.ts` as the alarm for its time (`the alarm "wekker" for 07:30`, plus how late), keeping the snooze wording. Verify with `alert-opening.test.ts`: an alarm, a late alarm and a snoozed alarm

## 3. Alert tools

- [x] 3.1 Add one view per alert (id, kind, label, device, `due`, `when`, seconds left, state) and the shared `pick` (id, else `label`/`due`/`kind` combined with AND; one match, else an error listing every active alert). Rename `list_timers` → `list_alerts` (timers and alarms) and `cancel_timer` → `cancel_alert`. Verify with `alert-tools.test.ts`: the core tool list, `list_alerts` with both kinds and `when`, cancel by `due` ("8:30" with 07:30 and 08:30 scheduled), by `kind`, ambiguous and no-match errors that change nothing, the only alert without arguments; update `app.test.ts`'s core tool list
- [x] 3.2 Add `when` to `set_timer`'s result, and say in its description that it is for a length of time and that a time of day is `set_alarm`. Verify with `alert-tools.test.ts`: the kitchen timer returns `when` `today at 12:05`
- [x] 3.3 Add `set_alarm` (`time`, `date`, `label` default `alarm`, `language`) with the device, control-connection and 20-per-device checks, `others`, and the duplicate guard. Verify with `alert-tools.test.ts`: the 23:41 → 07:30 case returns `morgen, woensdag 14 oktober, om 07:30` and the store holds kind `alarm`, `others` lists an 08:30 alarm, setting 07:30 twice returns the existing one, Talk page / no control connection / 21st alarm / day 8 / DST gap errors create nothing
- [x] 3.4 Add `change_alert` (`pick` plus `time`/`date` for an alarm or `seconds` for a timer) through `reschedule`. Verify with `alert-tools.test.ts`: 08:30 → 07:30 keeps the id and returns the previous `when` with no second alarm, `eggs` to 300 s from now, a ringing alarm refused, `seconds` for an alarm and `time` for a timer refused without change
- [x] 3.5 Replay 13 October in one test: set 08:30, "should be 7:30" via `change_alert`, `list_alerts` before confirming. Verify with `alert-tools.test.ts` ("13 October replayed") that exactly one alarm exists, due at 07:30 local, and that it rings at 07:30 on the fake clock

## 4. Prompt

- [x] 4.1 Add the timers and alarms paragraph to `prompts.voice` (alarm for a time of day, timer for a length, `change_alert` to correct and ask about other alarms, `list_alerts` before confirming, quote `when`). Verify with `chat-config.test.ts` (where the prompt texts are tested): the voice prompt names `set_alarm`, `change_alert` and `list_alerts`, and the chat prompt doesn't

## 5. Docs and context

- [x] 5.1 Update README's Alerts section (alarms, the 30-minute window, the six tools), `.env.example` (`FRIDAY_ALARM_RING_MINUTES`), and the Alerts paragraph of `openspec/config.yaml` (alarm kind, `clock-time.ts`/`when.ts`, tool names). On the Alerts page, say "timers and alarms" and show days in the time left for alarms days away. Leave `deploy/k8s.yaml` as is (default value). Verify by reading the diff and running `pnpm --filter @friday/core test` (the `.env.example` check) and `pnpm --filter @friday/portal test` (time left in days)

## 6. Integration

- [ ] 6.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree. Verify it is green
- [ ] 6.2 With a dev server on a free port and the reSpeaker pointed at it (or after deploy, with the user's approval), say "maak me morgen om half acht wakker", then "nee, om acht uur", then "dus je maakt me om acht uur wakker?". Verify on the Alerts page that one alarm exists for 08:00, and that the replies named 08:00 from `when`
- [ ] 6.3 Set an alarm two minutes ahead and leave it unanswered. Verify it keeps ringing past the fifth ring, and that saying "I'm up" acknowledges it
