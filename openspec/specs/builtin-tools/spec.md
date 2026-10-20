# Builtin Tools

## Purpose

Small native tools that ship with Friday: current time, countdown timers, and the `end_conversation` marker tool.

## Requirements

### Requirement: get_current_time

The tool SHALL return the current time as `iso` (UTC ISO 8601), `human` (a spoken-friendly full date and time in the requested zone) and `timezone`. The `timezone` parameter is an optional IANA zone; when omitted, the zone from `FRIDAY_TIMEZONE` SHALL be used, or `Europe/Amsterdam` when that is unset or invalid (an invalid configured zone is logged once as a warning). An explicit `timezone` SHALL be trimmed, and a blank one SHALL count as omitted. An explicit `timezone` that is not a valid IANA zone SHALL return an error naming it, rather than silently answering in another zone.

#### Scenario: Default zone
- **WHEN** called without a timezone
- **THEN** `human` is rendered in the default zone and `timezone` names that zone

#### Scenario: Explicit zone
- **WHEN** called with `timezone: "America/New_York"`
- **THEN** `human` is rendered in that zone and `timezone` echoes it

#### Scenario: Invalid configured zone
- **WHEN** `FRIDAY_TIMEZONE` is `Mars/Olympus` and the tool is called without a timezone
- **THEN** `human` is rendered in `Europe/Amsterdam`, `timezone` is `Europe/Amsterdam`, and a warning names `Mars/Olympus`

#### Scenario: Invalid explicit zone
- **WHEN** called with `timezone: "Mars/Olympus"`
- **THEN** the tool returns an error naming `Mars/Olympus`

### Requirement: end_conversation

The tool SHALL be named `end_conversation`, accept an optional `reason`, return `{ ending: true, reason, endConversation: reason }` (reason defaulting to `done`), and use scheduling `SILENT`. The `endConversation` key is the reserved registry key that signals the session to close after the model's current turn; it is stripped before the result reaches Gemini. It SHALL be available only in the `voice` channel. Its description SHALL tell the model to call it in the same turn as its final words once a request is fully handled or the user says goodbye, and never when those final words are a question or invite the user to talk.

#### Scenario: Called with reason
- **WHEN** the model calls `end_conversation` with `reason: "user said goodbye"`
- **THEN** Gemini receives `{ ending: true, reason: "user said goodbye" }` and the session closes after the turn with `ended: user said goodbye`

#### Scenario: Called without reason
- **WHEN** the model calls `end_conversation` with no args
- **THEN** the reason is `done`

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `end_conversation` is not among its declarations

#### Scenario: Description forbids ending after a question
- **WHEN** the voice declarations are listed
- **THEN** the `end_conversation` description says not to call it when the final words are a question

### Requirement: Builtin tools ship as the `builtin` module

`get_current_time` and `end_conversation` SHALL be provided by a module with id `builtin` in `modules/builtin`, defining its tools in `init(ctx)`.

#### Scenario: Module listed
- **WHEN** a client requests `/api/modules`
- **THEN** `builtin` is present with those two tool names
