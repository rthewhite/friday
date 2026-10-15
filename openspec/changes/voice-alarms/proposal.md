# Proposal

## Why

On the night of 13 October the user asked the reSpeaker to wake them at 07:30. No alarm rang at 07:30. Friday has no alarms, only countdown timers. The model worked out the seconds from a clock two hours off (UTC), so the first timer was due at 10:30 and the second at 09:30. It set a second timer instead of moving the first. "Remove the 8:30 one" matched neither due time, so Friday cancelled by label and removed the timer that should have stayed. Friday then confirmed "07:30" without looking at the timers. Every reply named the time the user asked for, not the time the tool returned. Waking up is the most common reason to set something on a bedside speaker, so it needs to be a real feature: Friday works out the time, and Friday's replies match what was stored.

## What Changes

- **Alarms**: a new alert kind `alarm`, due at a time of day in `FRIDAY_TIMEZONE`, set with a new voice tool `set_alarm` (`time` `HH:MM`, optional `date`, `label`, `language`). Core works out the instant: the next time that clock time occurs, or that time on the given date within the next 7 days. The model never does clock arithmetic. One-off alarms only.
- **Alarms keep ringing until someone reacts**, up to `FRIDAY_ALARM_RING_MINUTES` (default 30) after their due time. They don't stop after `FRIDAY_ALERT_RINGS`. The same window replaces the grace limit, so an alarm still rings when Friday or the device comes back within it. When a device's own tone runs out during that window, core rings the alarm again instead of marking it missed.
- **Change instead of add**: a new voice tool `change_alert` moves one scheduled alert. An alarm takes a new `time`/`date`, a timer a new length counted from now. It keeps the alert's id and label.
- **BREAKING (tool names)**: `list_timers` and `cancel_timer` become `list_alerts` and `cancel_alert`, covering timers and alarms. Both, and `change_alert`, pick an alert by `id`, `label` or `time` (its due clock time, e.g. `08:30`), optionally narrowed by `kind`. When several match, or none do, they change nothing and list the alerts. Only the model calls these tools, so nothing outside core breaks.
- **Results the model can repeat**: `set_timer`, `set_alarm`, `change_alert` and `list_alerts` return each alert's due time as a `when` phrase in the user's language and the household zone (e.g. `woensdag 14 oktober om 07:30`). Their descriptions tell the model to say that phrase, not the time it asked for.
- **Voice prompt rules**: use `set_alarm` for a time of day and `set_timer` only for a length of time; to correct an alert, call `change_alert` and never set a second one; before confirming what is set, call `list_alerts`.
- The announcement for an alarm says it is the alarm for 07:30, not "a timer of 7 hours 49 minutes". The Alerts page shows alarms as kind `alarm`.

Out of scope: repeating alarms (weekdays, every day), alarms in chat or as push notifications (a later target kind), and firmware changes.

## Capabilities

### New Capabilities

None. Alarms are part of `alerts`.

### Modified Capabilities

- `alerts`: the `alarm` kind and its ring window, the `set_alarm` and `change_alert` tools, `list_timers`/`cancel_timer` renamed and extended as `list_alerts`/`cancel_alert` with selection by time and kind, the `when` phrase in tool results, and the alarm's announcement. Note that `alerts` is still a delta of the unarchived change `device-alerts-and-timers`, which must be archived before this change can be.
- `voice-session`: the voice part of the system prompt gains the rules for timers and alarms.

## Impact

- `packages/core/src/alerts/`: `store.ts` (kind `alarm`, a count of scheduled alerts per kind), `service.ts` (ring window per kind, local-ring timeout during an alarm's window), `tools.ts` (new and renamed tools, selection, `when`), `opening.ts` (alarm wording), a new time-of-day resolver next to them.
- `packages/core/src/config.ts`: `FRIDAY_ALARM_RING_MINUTES` and the voice prompt text. No migration: `alerts.kind` is already free text.
- `packages/core/test/`: alert-store, alert-service, alert-tools, alert-opening, app (the core tool list) and alerts-e2e tests.
- `packages/portal/src/pages/settings/AlertsPage.vue`: only if the kind badge or the time-left column need changes for alarms that are days away.
- Docs: README (Alerts section), `.env.example`, `deploy/k8s.yaml` only if the new setting gets a value there, `openspec/config.yaml` context (Alerts paragraph).
- No other change is in flight on these files. `device-alerts-and-timers` is merged but waits for hardware tests before it is archived. This change doesn't touch firmware.
