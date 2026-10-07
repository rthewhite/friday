# Spec Delta

## MODIFIED Requirements

### Requirement: Builtin tools ship as the `builtin` module

`get_current_time` and `end_conversation` SHALL be provided by a module with id `builtin` in `modules/builtin`, defining its tools in `init(ctx)`.

#### Scenario: Module listed
- **WHEN** a client requests `/api/modules`
- **THEN** `builtin` is present with those two tool names

## REMOVED Requirements

### Requirement: set_timer

**Reason**: The builtin `set_timer` waited inside the tool call, which kept a Gemini Live session open for the whole countdown and could not ring after the conversation ended.

**Migration**: Timers are alerts now. `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert` are specified in `alerts`: `set_timer` returns at once, and the timer rings its device when it is due.
