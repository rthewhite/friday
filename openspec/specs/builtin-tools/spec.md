# Builtin Tools

## Purpose

Small native tools that ship with Friday: current time, countdown timers, and the `end_conversation` marker tool.

## Requirements

### Requirement: get_current_time

The tool SHALL return the current time as `iso` (UTC ISO 8601), `human` (a spoken-friendly full date and time in the requested zone) and `timezone`. The `timezone` parameter is an optional IANA zone; when omitted a configured default zone SHALL be used.

#### Scenario: Default zone
- **WHEN** called without a timezone
- **THEN** `human` is rendered in the default zone and `timezone` names that zone

#### Scenario: Explicit zone
- **WHEN** called with `timezone: "America/New_York"`
- **THEN** `human` is rendered in that zone and `timezone` echoes it

### Requirement: set_timer

The tool SHALL wait `seconds` (required integer) and then return `{ done: true, label, message }`, where `label` defaults to `timer`. Its default scheduling SHALL be `WHEN_IDLE` so the model announces completion without interrupting the user.

#### Scenario: Timer completes
- **WHEN** called with `seconds: 5, label: "eggs"`
- **THEN** after 5 seconds the result is `{ done: true, label: "eggs", message: "eggs finished after 5 seconds" }` with scheduling `WHEN_IDLE`

#### Scenario: Timer keeps session alive
- **WHEN** a timer is running and the model finishes its turn
- **THEN** the session's idle timeout is not armed until the timer completes

### Requirement: end_conversation

The tool SHALL be named `end_conversation`, accept an optional `reason`, return `{ ending: true, reason }` (reason defaulting to `done`), and use scheduling `SILENT`. Calling it SHALL signal the session to close after the model's current turn.

#### Scenario: Called with reason
- **WHEN** the model calls `end_conversation` with `reason: "user said goodbye"`
- **THEN** the result is `{ ending: true, reason: "user said goodbye" }` and the session closes after the turn with `ended: user said goodbye`

#### Scenario: Called without reason
- **WHEN** the model calls `end_conversation` with no args
- **THEN** the reason is `done`
