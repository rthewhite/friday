# Spec Delta

## ADDED Requirements

### Requirement: Alert sessions announce their alerts and wait for an answer

A session opened for ringing alerts (as specified in `audio-transport`) SHALL be an alert session for every alert ringing on its device at that moment. It SHALL open like any device session, with the same prompt, tools and device block, and then:
1. emit a short alert tone as `audio` events before any audio from Gemini, so the device plays it first;
2. send Gemini an opening turn that names each alert with its kind, label and due time, says how long ago it fell due when that is more than a minute, names the language the user spoke when setting it, and asks the model to announce the alerts briefly in that language and wait for the user's answer.

The user speaking or sending text for the first time in an alert session SHALL acknowledge its alerts (as specified in `alerts`). Until then, the session SHALL drop any end-of-conversation request, in addition to the exception in "Model-initiated end of conversation", so the model cannot end the session before the user reacted. After the user has reacted, the session SHALL behave like any other session. An alert session SHALL report when it closes, and whether its alerts were acknowledged or snoozed, so unanswered rings can be counted.

#### Scenario: Timer announcement
- **WHEN** an alert session opens for the `eggs` timer, set in Dutch
- **THEN** the device first receives the alert tone, then Friday's announcement of the `eggs` timer in Dutch

#### Scenario: Late announcement
- **WHEN** an alert session opens for a timer that fell due three minutes earlier
- **THEN** the opening turn says it went off three minutes ago

#### Scenario: Model tries to end right away
- **WHEN** the model announces the timer and calls `end_conversation` before the user said anything
- **THEN** the session stays open and the idle timer is armed

#### Scenario: User answers
- **WHEN** the user says "thanks, done" after the announcement
- **THEN** the alert is acknowledged, and when the model then calls `end_conversation` the session closes after the turn

#### Scenario: User barges in on the tone
- **WHEN** the user says "stop" while the alert tone plays
- **THEN** the tone is interrupted as any playback is, and the alert is acknowledged

## MODIFIED Requirements

### Requirement: Idle timeout closes the session

After a turn completes, the session SHALL close if the user has not spoken for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000). The close reason SHALL be `ended: no answer` when the session is an alert session and the user has not spoken or sent text in it yet, `ended: no follow-up (end after question)` when that turn's end request was dropped because it ended with a question, and `ended: no follow-up` otherwise. A value of 0 SHALL disable the timeout, including after a dropped end request, except in an alert session before the user has reacted, where the default of 8000 SHALL apply. The timer SHALL NOT be armed while any tool call is in flight, and SHALL be cancelled when the user speaks or a new tool call starts.

#### Scenario: User stays silent
- **WHEN** a turn completes and no input transcription arrives within the idle timeout
- **THEN** the session closes with `ended: no follow-up`

#### Scenario: User stays silent after a question with an end request
- **WHEN** an end request was dropped because the turn ended with a question, and no input transcription arrives within the idle timeout
- **THEN** the session closes with `ended: no follow-up (end after question)`

#### Scenario: Nobody answers an alert
- **WHEN** an alert session's announcement turn completes and nobody speaks within the idle timeout
- **THEN** the session closes with `ended: no answer` and its alerts are not acknowledged

#### Scenario: User speaks again
- **WHEN** an input transcription arrives before the idle timeout fires
- **THEN** the idle timer is cancelled

#### Scenario: Tool pending
- **WHEN** a turn completes while a tool call is still running
- **THEN** the idle timer is not armed

#### Scenario: Timeout disabled
- **WHEN** `FRIDAY_IDLE_TIMEOUT_MS` is 0
- **THEN** the session never closes for inactivity, except an alert session nobody has answered, which closes after 8 seconds

### Requirement: The session records its conversation

When given a recorder, a session SHALL record its conversation as specified in `conversation-store`, with channel `voice`: input transcriptions as user entries with input `speech`, text sent through the session as user entries with input `text`, output transcriptions as assistant entries (marked `interrupted` when Gemini reports an interruption), each tool call with its arguments and result, and the reason from its single `closed` event as the end reason. The opening turn of an alert session SHALL NOT be recorded, because the user did not say it; its conversation starts with Friday's announcement. Recording SHALL NOT change what the session emits to its transport, or when it closes.

#### Scenario: Typed text is recorded
- **WHEN** a client sends `{"type":"text","text":"what time is it"}` and the model answers
- **THEN** the conversation holds a user entry with input `text` and the assistant's answer

#### Scenario: End reason
- **WHEN** the model calls `end_conversation` with reason `done` and the session closes
- **THEN** the conversation is quiet with end reason `ended: done`

#### Scenario: Alert conversation
- **WHEN** an alert session announces the `eggs` timer and the user answers "thanks"
- **THEN** the conversation's first entry is Friday's announcement, followed by the user's "thanks", with no user entry for the opening turn

#### Scenario: Events unchanged
- **WHEN** a session records its conversation
- **THEN** the client receives exactly the events it would receive without recording
