# Spec Delta

## Purpose

Lets Friday start talking on its own: alerts such as kitchen timers are stored with a due time and a target, and when one is due Friday rings the target voice device, announces the alert in a conversation the user can answer, and keeps ringing until someone reacts.

## ADDED Requirements

### Requirement: Alerts are stored with a due time and a target

Core SHALL store each alert in `friday.db` with:
- an id,
- a kind (`timer` in this version),
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

#### Scenario: Restart before the due time
- **WHEN** Friday restarts at 12:02 while that timer is scheduled
- **THEN** the timer is still scheduled for 12:05 and rings then

#### Scenario: Device deleted
- **WHEN** the user deletes `friday-kitchen` while it has a scheduled timer
- **THEN** the timer is `cancelled` and never rings

### Requirement: A due alert rings its device

When an alert is due, core SHALL ring its target device: it SHALL set the alert to `ringing` and send a `ring` message for it over the device's control connection (as specified in `audio-transport`). A ring SHALL be answered when the device opens an alert session for it (as specified in `voice-session`) within 15 seconds. When several alerts of the same device are due, one ring and one alert session SHALL cover all of them. When the device has a conversation open when an alert falls due, the ring SHALL wait until that conversation's session closes. When the device has no control connection open, the ring SHALL wait until the device connects. Every wait SHALL end at the alert's grace limit (see "Late alerts are missed").

#### Scenario: Timer goes off
- **WHEN** the `eggs` timer of `friday-kitchen` falls due and the device's control connection is open
- **THEN** the alert is `ringing` and the device receives `ring` for it

#### Scenario: Two timers at once
- **WHEN** timers `eggs` and `pasta` of `friday-kitchen` fall due within the same second
- **THEN** the device receives one `ring`, and the alert session that follows announces both

#### Scenario: Device busy
- **WHEN** a timer falls due while the user is talking to Friday on the same device
- **THEN** no `ring` is sent until that conversation ends, and then it is sent at once

#### Scenario: Device offline for a moment
- **WHEN** a timer falls due while its device is reconnecting, and the device connects 20 seconds later
- **THEN** the device receives `ring` right after it connects

### Requirement: An alert rings again until someone reacts

An alert SHALL be `acknowledged` when the user speaks or sends text in an alert session that announces it, or presses the device's button while it rings (reported over the control connection). A ring SHALL count as unanswered when the device does not open an alert session within 15 seconds, or when the alert session closes without the alert being acknowledged or snoozed. After an unanswered ring, core SHALL ring again after `FRIDAY_ALERT_RING_INTERVAL_MS` (default 60000). After `FRIDAY_ALERT_RINGS` unanswered rings (default 5), the alert SHALL be `missed` and SHALL NOT ring again. When a device reports that it rings an alert with its local tone, core SHALL NOT ring that alert again while that device's control connection stays open: the device's report of a button press SHALL make it `acknowledged`, and its report that the tone ran out SHALL make it `missed`. When the device's control connection opens again, core SHALL ring its locally rung alerts again at once, so a device still ringing reports it afresh and a device that stopped (a report lost, or a restart) announces it. A local ring nobody reports on SHALL be `missed` 60 minutes after it was reported, the longest a device rings. A button press reported during an alert session SHALL acknowledge every alert that session announces.

#### Scenario: Answered at once
- **WHEN** the `eggs` timer rings, Friday announces it and the user says "thanks"
- **THEN** the alert is `acknowledged` and does not ring again

#### Scenario: Nobody in the kitchen
- **WHEN** the `eggs` timer rings and nobody answers five times, a minute apart
- **THEN** the alert is `missed` and does not ring a sixth time

#### Scenario: Answered on the third ring
- **WHEN** the first two rings go unanswered and the user answers the third
- **THEN** the alert is `acknowledged`

#### Scenario: Local tone stopped by the button
- **WHEN** the device reports that it rings the alert with its local tone, and later that its button stopped it
- **THEN** core sends no further `ring` for it, and the alert is `acknowledged`

#### Scenario: Local tone ran out
- **WHEN** the device reports that its local tone for an alert ran out without a button press
- **THEN** the alert is `missed`

#### Scenario: Control connection back while ringing locally
- **WHEN** a device rings an alert locally, its control connection drops and comes back
- **THEN** core rings that alert again at once, and the device, still ringing, reports `ringing_locally` again

#### Scenario: Button with two timers announced
- **WHEN** an alert session announces timers `eggs` and `pasta` and the user presses the button
- **THEN** both are `acknowledged` and neither rings again

### Requirement: Late alerts are missed

No ring of an alert SHALL start later than `FRIDAY_ALERT_GRACE_MS` (default 600000) after its due time. An alert still waiting for its first or next ring when that limit passes, whether because Friday was down, its device was offline or busy, or its rings went unanswered, SHALL be `missed`. A ring in progress when the limit passes (an open alert session, or the device ringing locally) SHALL NOT be cut off, and its outcome decides the alert's state. At startup, an alert whose due time passed while Friday was down SHALL ring at once when it is within that limit, and be `missed` otherwise.

#### Scenario: Short restart
- **WHEN** a timer was due at 12:05 and Friday starts again at 12:07
- **THEN** the timer rings right after startup, and Friday says it went off two minutes ago

#### Scenario: Long outage
- **WHEN** a timer was due at 12:05 and Friday starts again at 12:30
- **THEN** the timer is `missed` and does not ring

#### Scenario: Device offline past the limit
- **WHEN** a timer falls due while its device has no control connection, and the device is still offline ten minutes later
- **THEN** the timer is `missed`

### Requirement: Snoozing moves an alert later

Snoozing an alert SHALL set its due time to the snooze length after the moment of snoozing, set it back to `scheduled`, and reset its count of unanswered rings. A snoozed alert SHALL ring again as any scheduled alert does.

#### Scenario: Snooze from the alert session
- **WHEN** the `eggs` timer rings at 12:05 and the user says "snooze two minutes"
- **THEN** the timer is `scheduled` again for 12:07, and rings then with up to five rings

### Requirement: set_timer

The tool `set_timer` SHALL take `seconds` (an integer from 1 to 86400), an optional `label` (up to 60 characters, `timer` when omitted or blank) and `language` (`nl` or `en`, the language the user is speaking). It SHALL create a `timer` alert due `seconds` from now, targeting the device whose session the call comes from, and return at once with the timer's id, label, due time in `FRIDAY_TIMEZONE` and length. It SHALL be available only in the `voice` channel. A call from a session without a device (the portal's Talk page) SHALL return an error saying that timers can only be set on a voice device for now. A call from a device without an open control connection SHALL return an error saying that the device can't ring and may need a firmware update, and SHALL NOT create the timer. A device SHALL have at most 20 `scheduled` timers; setting another SHALL return an error.

#### Scenario: Kitchen timer
- **WHEN** the user says "set a timer for 5 minutes for the eggs" on `friday-kitchen` at 12:00:00
- **THEN** `set_timer` is called with `seconds: 300, label: "eggs"`, returns at once with the due time 12:05:00, and the session ends normally

#### Scenario: No device
- **WHEN** `set_timer` is called in a Talk page session
- **THEN** it returns an error saying timers need a voice device, and no alert is created

#### Scenario: Old firmware
- **WHEN** `set_timer` is called from a device that has no control connection
- **THEN** it returns an error saying the device can't ring, and no alert is created

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `set_timer` is not among its declarations

### Requirement: list_timers

The tool `list_timers` SHALL return every `scheduled` and `ringing` timer of every device, each with its id, label, device label, due time in `FRIDAY_TIMEZONE`, the seconds left, and its state. It SHALL be available only in the `voice` channel.

#### Scenario: How long left
- **WHEN** the `eggs` timer is due at 12:05:00 and the user asks at 12:03:30 how long the eggs have left
- **THEN** `list_timers` returns `eggs` with 90 seconds left

#### Scenario: Nothing running
- **WHEN** no timer is scheduled or ringing
- **THEN** `list_timers` returns an empty list

### Requirement: cancel_timer

The tool `cancel_timer` SHALL take an optional `id` and an optional `label`. It SHALL cancel the `scheduled` or `ringing` timer with that id, or else the one with that label (compared without regard to letter case). When neither is given and exactly one timer is scheduled or ringing, it SHALL cancel that one. When no timer matches, or several match and no id is given, it SHALL cancel nothing and return an error listing the timers that are scheduled or ringing, so the model can ask which one. It SHALL be available only in the `voice` channel. A cancelled timer SHALL be `cancelled` and SHALL NOT ring.

#### Scenario: Cancel by label
- **WHEN** timers `eggs` and `pasta` are scheduled and the user says "cancel the pasta timer"
- **THEN** `pasta` is `cancelled` and `eggs` still rings when due

#### Scenario: Ambiguous
- **WHEN** two timers labelled `timer` are scheduled and `cancel_timer` is called with `label: "timer"`
- **THEN** nothing is cancelled and the error lists both with their ids and due times

#### Scenario: The only timer
- **WHEN** one timer is scheduled and `cancel_timer` is called without arguments
- **THEN** that timer is cancelled

### Requirement: snooze_alert

The tool `snooze_alert` SHALL take `minutes` (an integer from 1 to 60, default 5) and SHALL snooze every alert announced in the alert session it is called from, then return their labels and new due time. It SHALL be available only in the `voice` channel. Called from a session that is not an alert session, it SHALL return an error saying nothing is ringing.

#### Scenario: Snooze
- **WHEN** the user answers a ringing `eggs` timer with "give me five more minutes"
- **THEN** `snooze_alert` is called with `minutes: 5`, and the timer rings again five minutes later

#### Scenario: Nothing ringing
- **WHEN** `snooze_alert` is called in a conversation the user started with the wake word
- **THEN** it returns an error saying nothing is ringing, and no alert changes

### Requirement: Alerts API

Core SHALL serve:
- `GET /api/alerts`: `{ alerts }`, every alert that is `scheduled` or `ringing`, then the alerts in a final state, newest first. Each alert has `id`, `kind`, `label`, `dueAt`, `target` (`{ kind, id, label }`, with the device's current label, or no label when the device no longer exists), `state`, `createdAt`, `finishedAt` and `rings` (the unanswered rings so far).
- `DELETE /api/alerts/:id`: cancels a `scheduled` or `ringing` alert and answers 204. It SHALL answer 404 for an unknown alert and 409 for an alert in a final state.

#### Scenario: Listing
- **WHEN** one timer is scheduled and one was missed yesterday
- **THEN** `GET /api/alerts` lists the scheduled timer first, then the missed one with its `finishedAt`

#### Scenario: Cancel from the portal
- **WHEN** `DELETE /api/alerts/<id>` is called for a scheduled timer
- **THEN** the response is 204 and the timer does not ring

### Requirement: Alerts page

The portal SHALL provide an `Alerts` page at `/settings/alerts`. It SHALL show:
- the `scheduled` and `ringing` alerts, each with label, kind, device, due time and time left, and a `Cancel` action;
- the alerts in a final state, newest first, each with label, kind, device, due time and outcome, where `missed` alerts stand out.

The page SHALL offer a `Refresh` header action.

#### Scenario: Missed timer
- **WHEN** a timer was missed while nobody was home
- **THEN** the page lists it as missed, with its device and due time

#### Scenario: Cancel
- **WHEN** the user clicks `Cancel` on a scheduled timer
- **THEN** the timer moves to the finished list as `cancelled`
