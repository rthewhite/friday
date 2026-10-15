# Spec Delta

## MODIFIED Requirements

### Requirement: Alerts are stored with a due time and a target

Core SHALL store each alert in `friday.db` with:
- an id,
- a kind: `timer` (a length of time) or `alarm` (a time of day),
- a label,
- its due time,
- a target, made of a target kind and a target id; the only target kind in this version SHALL be `device`, whose target id is a registered voice device,
- the language the user spoke when setting it (`nl` or `en`),
- the time it was created, and the conversation it was created in when there is one,
- its state: `scheduled`, `ringing`, `acknowledged`, `cancelled` or `missed`,
- the time it reached a final state (`acknowledged`, `cancelled` or `missed`), when it did.

Alerts SHALL survive a restart of Friday. Core SHALL keep at most the 200 most recent alerts in a final state and delete older ones. Deleting a device SHALL cancel its `scheduled` and `ringing` alerts.

#### Scenario: Timer stored
- **WHEN** a timer of 300 seconds labelled `eggs` is set from device `friday-kitchen` at 12:00:00
- **THEN** `friday.db` holds an alert of kind `timer`, label `eggs`, due at 12:05:00, target `device` `friday-kitchen`, state `scheduled`

#### Scenario: Alarm stored
- **WHEN** an alarm for 07:30 labelled `wekker` is set from device `friday-respeaker` at 23:41 on Tuesday 13 October
- **THEN** `friday.db` holds an alert of kind `alarm`, label `wekker`, due at 07:30 on Wednesday 14 October in `FRIDAY_TIMEZONE`, state `scheduled`

#### Scenario: Restart before the due time
- **WHEN** Friday restarts at 12:02 while that timer is scheduled
- **THEN** the timer is still scheduled for 12:05 and rings then

#### Scenario: Device deleted
- **WHEN** the user deletes `friday-kitchen` while it has a scheduled timer
- **THEN** the timer is `cancelled` and never rings

### Requirement: An alert rings again until someone reacts

An alert SHALL be `acknowledged` when the user speaks or sends text in an alert session that announces it, or presses the device's button while it rings (reported over the control connection). A ring SHALL count as unanswered when the device does not open an alert session within 15 seconds, or when the alert session closes without the alert being acknowledged or snoozed. After an unanswered ring, core SHALL ring again after `FRIDAY_ALERT_RING_INTERVAL_MS` (default 60000).

A timer SHALL be `missed` after `FRIDAY_ALERT_RINGS` unanswered rings (default 5) and SHALL NOT ring again. An alarm SHALL NOT be limited by `FRIDAY_ALERT_RINGS`: it SHALL ring again after each unanswered ring until it is acknowledged, snoozed or cancelled, or its ring window ends (see "Late alerts are missed").

When a device reports that it rings an alert with its local tone, core SHALL NOT ring that alert again while that device's control connection stays open: the device's report of a button press SHALL make it `acknowledged`. The device's report that the tone ran out SHALL make a timer `missed`; for an alarm it SHALL count as an unanswered ring, so the alarm rings again after `FRIDAY_ALERT_RING_INTERVAL_MS` while its ring window lasts and is `missed` otherwise. When the device's control connection opens again, core SHALL ring its locally rung alerts again at once, so a device still ringing reports it afresh and a device that stopped (a report lost, or a restart) announces it. A local ring nobody reports on SHALL be `missed` 60 minutes after it was reported, the longest a device rings. A button press reported during an alert session SHALL acknowledge every alert that session announces.

#### Scenario: Answered at once
- **WHEN** the `eggs` timer rings, Friday announces it and the user says "thanks"
- **THEN** the alert is `acknowledged` and does not ring again

#### Scenario: Nobody in the kitchen
- **WHEN** the `eggs` timer rings and nobody answers five times, a minute apart
- **THEN** the alert is `missed` and does not ring a sixth time

#### Scenario: Answered on the third ring
- **WHEN** the first two rings go unanswered and the user answers the third
- **THEN** the alert is `acknowledged`

#### Scenario: Alarm keeps ringing
- **WHEN** an alarm due at 07:30 is not answered five times, a minute apart
- **THEN** it rings a sixth time at about 07:35, and keeps ringing a minute after each unanswered ring

#### Scenario: Alarm answered after ten minutes
- **WHEN** an alarm due at 07:30 is answered with "I'm up" on a ring at 07:40
- **THEN** it is `acknowledged` and does not ring again

#### Scenario: Local tone stopped by the button
- **WHEN** the device reports that it rings the alert with its local tone, and later that its button stopped it
- **THEN** core sends no further `ring` for it, and the alert is `acknowledged`

#### Scenario: Local tone ran out
- **WHEN** the device reports that its local tone for a timer ran out without a button press
- **THEN** the timer is `missed`

#### Scenario: Local tone ran out on an alarm
- **WHEN** the reSpeaker is muted, rings an alarm due at 07:30 with its local tone, and reports at 07:35 that the tone ran out
- **THEN** the alarm is still `ringing` and core rings the device again a minute later

#### Scenario: Control connection back while ringing locally
- **WHEN** a device rings an alert locally, its control connection drops and comes back
- **THEN** core rings that alert again at once, and the device, still ringing, reports `ringing_locally` again

#### Scenario: Button with two timers announced
- **WHEN** an alert session announces timers `eggs` and `pasta` and the user presses the button
- **THEN** both are `acknowledged` and neither rings again

### Requirement: Late alerts are missed

No ring of a timer SHALL start later than `FRIDAY_ALERT_GRACE_MS` (default 600000) after its due time. No ring of an alarm SHALL start later than `FRIDAY_ALARM_RING_MINUTES` (default 30) after its due time; that span is the alarm's ring window. An alert still waiting for its first or next ring when its limit passes, whether because Friday was down, its device was offline or busy, or its rings went unanswered, SHALL be `missed`. A ring in progress when the limit passes (an open alert session, or the device ringing locally) SHALL NOT be cut off, and its outcome decides the alert's state. At startup, an alert whose due time passed while Friday was down SHALL ring at once when it is within its limit, and be `missed` otherwise. A snoozed alert's limit SHALL count from its new due time.

#### Scenario: Short restart
- **WHEN** a timer was due at 12:05 and Friday starts again at 12:07
- **THEN** the timer rings right after startup, and Friday says it went off two minutes ago

#### Scenario: Long outage
- **WHEN** a timer was due at 12:05 and Friday starts again at 12:30
- **THEN** the timer is `missed` and does not ring

#### Scenario: Device offline past the limit
- **WHEN** a timer falls due while its device has no control connection, and the device is still offline ten minutes later
- **THEN** the timer is `missed`

#### Scenario: Alarm after an outage
- **WHEN** an alarm was due at 07:30 and Friday starts again at 07:45
- **THEN** the alarm rings right after startup and keeps ringing until 08:00 at the latest

#### Scenario: Alarm window ends
- **WHEN** an alarm due at 07:30 is still unanswered when 08:00 passes and no ring is in progress
- **THEN** the alarm is `missed` and does not ring again

### Requirement: set_timer

The tool `set_timer` SHALL take `seconds` (an integer from 1 to 86400), an optional `label` (up to 60 characters, `timer` when omitted or blank) and `language` (`nl` or `en`, the language the user is speaking). It SHALL create a `timer` alert due `seconds` from now, targeting the device whose session the call comes from, and return at once with the timer's id, label, due time `HH:MM` in `FRIDAY_TIMEZONE`, its `when` (see "Tool results say when an alert is due") and length. Its description SHALL say it is for a length of time, and that a time of day is an alarm (`set_alarm`). It SHALL be available only in the `voice` channel. A call from a session without a device (the portal's Talk page) SHALL return an error saying that timers can only be set on a voice device for now. A call from a device without an open control connection SHALL return an error saying that the device can't ring and may need a firmware update, and SHALL NOT create the timer. A device SHALL have at most 20 `scheduled` timers; setting another SHALL return an error.

#### Scenario: Kitchen timer
- **WHEN** the user says "set a timer for 5 minutes for the eggs" on `friday-kitchen` at 12:00:00
- **THEN** `set_timer` is called with `seconds: 300, label: "eggs"`, returns at once with the due time `12:05` and `when` `today at 12:05`, and the session ends normally

#### Scenario: No device
- **WHEN** `set_timer` is called in a Talk page session
- **THEN** it returns an error saying timers need a voice device, and no alert is created

#### Scenario: Old firmware
- **WHEN** `set_timer` is called from a device that has no control connection
- **THEN** it returns an error saying the device can't ring, and no alert is created

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `set_timer` is not among its declarations

## ADDED Requirements

### Requirement: Tool results say when an alert is due

Every alert in the result of an alert tool SHALL carry `when`: its due time as a phrase in the alert's language, in `FRIDAY_TIMEZONE`, with the time as 24-hour `HH:MM`:
- due today: `vandaag om 07:30` / `today at 07:30`,
- due tomorrow: `morgen, woensdag 14 oktober, om 07:30` / `tomorrow, Wednesday 14 October, at 07:30`,
- due later: `vrijdag 16 oktober om 07:30` / `Friday 16 October at 07:30`.

The descriptions of `set_timer`, `set_alarm`, `change_alert`, `list_alerts` and `cancel_alert` SHALL tell the model to name an alert's time from its `when` (or the seconds left), not from what the user asked for.

#### Scenario: Alarm for tomorrow, in Dutch
- **WHEN** an alarm set in Dutch at 23:41 on Tuesday 13 October is due at 07:30 the next morning
- **THEN** its `when` is `morgen, woensdag 14 oktober, om 07:30`

#### Scenario: Timer in English
- **WHEN** a timer set in English at 12:00 is due at 12:05 the same day
- **THEN** its `when` is `today at 12:05`

#### Scenario: Zone, not UTC
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` in summer time and an alert is due at 05:30 UTC
- **THEN** its `when` names 07:30

### Requirement: set_alarm

The tool `set_alarm` SHALL take `time` (24-hour `HH:MM`, from `00:00` to `23:59`), an optional `date` (`YYYY-MM-DD`), an optional `label` (up to 60 characters, `alarm` when omitted or blank) and `language` (`nl` or `en`, the language the user is speaking). Core SHALL work out the due time in `FRIDAY_TIMEZONE`: without `date`, the next moment that clock time occurs after now (today when it is still ahead, else tomorrow); with `date`, that time on that date, which SHALL be in the future and at most 7 days ahead. A clock time that does not occur on that date (skipped by a change to summer time) SHALL return an error; a clock time that occurs twice (a change to winter time) SHALL mean the first. It SHALL create an `alarm` alert targeting the device whose session the call comes from, and return at once with the alarm's id, label, due time `HH:MM`, its `when`, how long until it rings, and the other `scheduled` alarms of that device (each with id, label and `when`). Setting an alarm when a `scheduled` alarm of the same device is already due at that moment SHALL create nothing and return the existing alarm, saying it was already set.

The description SHALL say it is for a time of day ("wake me at 7:30", "om half acht"), that the model passes the time as the user said it and never works out seconds, and that a wrong or changed alarm is moved with `change_alert` rather than set again. It SHALL be available only in the `voice` channel, with the same errors as `set_timer` for a session without a device and a device without an open control connection, and SHALL NOT create the alarm in those cases. A device SHALL have at most 20 `scheduled` alarms; setting another SHALL return an error. A `time` or `date` in another form, a date in the past or more than 7 days ahead SHALL return an error and create nothing.

#### Scenario: Wake me tomorrow
- **WHEN** at 23:41 on Tuesday 13 October the user says "maak me morgen om half acht wakker" on `friday-respeaker`
- **THEN** `set_alarm` is called with `time: "07:30"` and `language: "nl"`, and returns an alarm due at 07:30 on Wednesday 14 October in `FRIDAY_TIMEZONE` with `when` `morgen, woensdag 14 oktober, om 07:30`

#### Scenario: Later today
- **WHEN** at 06:00 the user sets an alarm for 07:30
- **THEN** the alarm is due at 07:30 the same day

#### Scenario: Time already passed today
- **WHEN** at 08:00 the user sets an alarm for 07:30 without a date
- **THEN** the alarm is due at 07:30 tomorrow

#### Scenario: Given date
- **WHEN** on Tuesday 13 October `set_alarm` is called with `time: "06:45"` and `date: "2026-10-16"`
- **THEN** the alarm is due at 06:45 on Friday 16 October

#### Scenario: Too far ahead
- **WHEN** `set_alarm` is called with a date 8 days from today
- **THEN** it returns an error and no alarm is created

#### Scenario: Other alarms shown
- **WHEN** `friday-respeaker` has an alarm for 08:30 and the user sets one for 07:30
- **THEN** the result lists the 08:30 alarm among the other alarms, so the model can ask whether it should go

#### Scenario: Set twice
- **WHEN** an alarm for 07:30 tomorrow is scheduled on the device and `set_alarm` is called again with `time: "07:30"`
- **THEN** no second alarm is created and the result returns the existing one as already set

#### Scenario: Skipped by summer time
- **WHEN** `set_alarm` is called with `time: "02:30"` for the night the clocks go forward in `FRIDAY_TIMEZONE`
- **THEN** it returns an error saying that time doesn't occur that night, and no alarm is created

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `set_alarm` is not among its declarations

### Requirement: Alert tools pick an alert by id, label, due time or kind

`list_alerts` aside, the alert tools that act on one alert (`change_alert`, `cancel_alert`) SHALL take an optional `id`, `label`, `due` (24-hour `HH:MM`, the alert's due time in `FRIDAY_TIMEZONE`) and `kind` (`timer` or `alarm`), and SHALL consider the `scheduled` and `ringing` alerts of every device. With `id`, only the alert with that id SHALL match. Otherwise an alert SHALL match when it agrees with each of `label` (compared without regard to letter case), `due` and `kind` that is given; with none of them given, every alert matches. When exactly one alert matches, the tool SHALL act on it. When none or several match, the tool SHALL change nothing and return an error with every `scheduled` and `ringing` alert (id, kind, label, device, `when`), so the model can ask which one.

#### Scenario: By due time
- **WHEN** alarms are scheduled for 07:30 and 08:30 and the user says "remove the 8:30 alarm"
- **THEN** `cancel_alert` with `due: "08:30"` cancels the 08:30 alarm and the 07:30 alarm still rings

#### Scenario: Label shared by kind
- **WHEN** a timer `pasta` and an alarm `wekker` are scheduled and `cancel_alert` is called with `kind: "alarm"`
- **THEN** the alarm `wekker` is cancelled

#### Scenario: Due time matches nothing
- **WHEN** alarms are scheduled for 09:30 and 10:30 and `cancel_alert` is called with `due: "08:30"`
- **THEN** nothing is cancelled and the error lists both alarms with their `when`

### Requirement: list_alerts

The tool `list_alerts` SHALL return every `scheduled` and `ringing` timer and alarm of every device, by due time, each with its id, kind, label, device label, due time `HH:MM` in `FRIDAY_TIMEZONE`, `when`, the seconds left, and its state. Its description SHALL tell the model to call it before telling the user which alerts are set. It SHALL be available only in the `voice` channel.

#### Scenario: How long left
- **WHEN** the `eggs` timer is due at 12:05:00 and the user asks at 12:03:30 how long the eggs have left
- **THEN** `list_alerts` returns `eggs` with 90 seconds left

#### Scenario: Confirming the alarm
- **WHEN** the user asks "so you'll wake me at 07:30?" and the only alarm is due at 10:30
- **THEN** `list_alerts` returns that alarm with `when` naming 10:30, so the model can say it is set for 10:30, not 07:30

#### Scenario: Nothing running
- **WHEN** no timer or alarm is scheduled or ringing
- **THEN** `list_alerts` returns an empty list

### Requirement: cancel_alert

The tool `cancel_alert` SHALL cancel the one `scheduled` or `ringing` timer or alarm picked as specified in "Alert tools pick an alert by id, label, due time or kind", and return its id, kind, label and `when`. A cancelled alert SHALL be `cancelled` and SHALL NOT ring. It SHALL be available only in the `voice` channel.

#### Scenario: Cancel by label
- **WHEN** timers `eggs` and `pasta` are scheduled and the user says "cancel the pasta timer"
- **THEN** `pasta` is `cancelled` and `eggs` still rings when due

#### Scenario: Ambiguous
- **WHEN** two timers labelled `timer` are scheduled and `cancel_alert` is called with `label: "timer"`
- **THEN** nothing is cancelled and the error lists both with their ids and `when`

#### Scenario: The only alert
- **WHEN** one timer is scheduled and `cancel_alert` is called without arguments
- **THEN** that timer is cancelled

### Requirement: change_alert

The tool `change_alert` SHALL move the one `scheduled` timer or alarm picked as specified in "Alert tools pick an alert by id, label, due time or kind". For an alarm it SHALL take `time` and optionally `date`, with the same rules and errors as `set_alarm`. For a timer it SHALL take `seconds`, with the same range as `set_timer`, counted from now. The alert SHALL keep its id, kind, label, language and device, and SHALL be `scheduled` at the new due time with no unanswered rings. It SHALL return the alert's id, kind, label, new due time, new `when` and previous `when`. A `ringing` alert SHALL NOT be changed: the tool SHALL return an error saying it is ringing and can be snoozed or cancelled. `seconds` for an alarm, or `time`/`date` for a timer, SHALL return an error and change nothing. Its description SHALL say that correcting or moving an alert is done with this tool, never by setting another one. It SHALL be available only in the `voice` channel.

#### Scenario: Correct the alarm time
- **WHEN** an alarm for 08:30 is scheduled and the user says "no, the alarm should be at 7:30"
- **THEN** `change_alert` with `time: "07:30"` moves that alarm to 07:30, keeps its id, and returns the previous `when` naming 08:30; no second alarm exists

#### Scenario: Longer timer
- **WHEN** the `eggs` timer has two minutes left and the user says "make the eggs timer 5 minutes"
- **THEN** `change_alert` with `label: "eggs", seconds: 300` makes it due 5 minutes from now

#### Scenario: Ringing alarm
- **WHEN** an alarm is ringing and `change_alert` is called for it
- **THEN** it returns an error saying it is ringing, and the alarm keeps ringing

#### Scenario: Wrong field for the kind
- **WHEN** `change_alert` is called with `seconds` for an alarm
- **THEN** it returns an error and the alarm is unchanged

## REMOVED Requirements

### Requirement: list_timers

**Reason**: Alarms are alerts too. A tool named after timers invites the model to miss them, or to set a timer for a time of day.

**Migration**: `list_alerts` lists timers and alarms, with the same fields plus `kind` and `when`.

### Requirement: cancel_timer

**Reason**: Replaced by `cancel_alert`, which covers alarms and can pick an alert by its due time, so "remove the 8:30 one" cannot cancel another alert by label.

**Migration**: Call `cancel_alert` with `id`, `label`, `due` or `kind`. An ambiguous call still cancels nothing and lists the alerts.
