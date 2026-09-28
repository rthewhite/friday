# Module LLM

## Purpose

Gives in-process modules text generation outside a voice session, through a core-owned model. The output is checked against a schema when asked for, failures are typed, calls are cancellable and bounded, and usage is logged, so background work such as a nightly memory pass can rely on it.

## Requirements

### Requirement: Modules generate text through the context

`ctx.llm.generate(request)` SHALL accept an optional `system` instruction, exactly one of `prompt` (a string) or `messages` (an ordered list of `{ role: "user" | "model", text }`), an optional JSON `schema`, an optional `model` tier (`standard`, the default, or `fast`), optional `temperature` and `maxOutputTokens`, an optional abort `signal`, and an optional `timeoutMs`. It SHALL resolve to `{ text, model, usage: { inputTokens, outputTokens } }`, plus `json` when a schema was given. A request with both or neither of `prompt` and `messages` SHALL be rejected with `invalid_request` without calling the model.

#### Scenario: Plain text
- **WHEN** a module calls `generate({ prompt: "Summarise: ..." })`
- **THEN** it receives the model's text, the model name that answered, and the token usage

#### Scenario: Conversation-shaped input
- **WHEN** a module passes `messages` with alternating user and model turns
- **THEN** the model receives them in that order, after the system instruction

#### Scenario: Ambiguous input
- **WHEN** a request contains both `prompt` and `messages`
- **THEN** it rejects with `invalid_request` and no model call is made

### Requirement: Structured output is validated

When a request carries a `schema`, the model SHALL be asked for JSON conforming to it, and the response SHALL be parsed and validated against the schema before it is returned. A response that is not valid JSON, does not conform, or was cut off by the output limit SHALL reject with `invalid_output`, and the error SHALL carry the raw text. A schema that is not a valid JSON Schema SHALL reject with `invalid_request` before any model call. A conforming empty result, such as an empty array, SHALL resolve normally.

#### Scenario: Conforming output
- **WHEN** a request asks for `{ "type": "object", "properties": { "facts": { "type": "array" } }, "required": ["facts"] }` and the model returns `{"facts": []}`
- **THEN** it resolves with `json` equal to `{ facts: [] }`

#### Scenario: Non-conforming output
- **WHEN** the model returns `{"fact": "x"}` for that schema
- **THEN** the call rejects with `invalid_output` carrying the raw text, not an empty result

#### Scenario: Truncated output
- **WHEN** the model stops because it reached `maxOutputTokens`
- **THEN** a schema request rejects with `invalid_output` stating the output was truncated

### Requirement: Failures are typed

Every rejection from `ctx.llm.generate` SHALL be an error whose `kind` is one of:
- `unavailable`: the model can't be reached, is rate-limited, errors on the provider side, the key is not configured, or the call timed out.
- `invalid_output`
- `blocked`: the provider refused the prompt, or stopped the response for safety or a similar reason. The error carries the provider's reason.
- `invalid_request`
- `cancelled`: the caller's signal was aborted.

Rate limits, provider-side errors and network errors SHALL be retried up to 2 times with increasing delay before rejecting with `unavailable`. Other kinds SHALL NOT be retried.

#### Scenario: Transient error
- **WHEN** the provider returns HTTP 503 once and then succeeds
- **THEN** the call resolves with the successful response

#### Scenario: Persistent outage
- **WHEN** the provider keeps returning HTTP 503
- **THEN** the call rejects with `unavailable` after 3 attempts in total

#### Scenario: Blocked prompt
- **WHEN** the provider blocks the prompt for safety
- **THEN** the call rejects with `blocked` and the provider's reason, without retrying

#### Scenario: No key
- **WHEN** `GEMINI_API_KEY` is not set
- **THEN** calls reject with `unavailable` stating that the key is not configured

### Requirement: Calls are cancellable and time-limited

A call SHALL reject with `cancelled` as soon as its signal is aborted, whether it is waiting for a concurrency slot or in flight, and an in-flight provider request SHALL be aborted. A call SHALL time out after `timeoutMs`, or after `FRIDAY_LLM_TIMEOUT_MS` (default 120000) when none is given, and then reject with `unavailable`.

#### Scenario: Job cancelled mid-call
- **WHEN** a job passes its abort signal to `generate` and the job is cancelled during the call
- **THEN** the provider request is aborted and the call rejects with `cancelled`

#### Scenario: Timeout
- **WHEN** a call with `timeoutMs: 10000` gets no response within 10 seconds
- **THEN** it rejects with `unavailable` stating the timeout

### Requirement: Core owns the provider, the key and the models

Core SHALL serve `ctx.llm` from Gemini through `@google/genai`, using the existing `GEMINI_API_KEY`, separately from the Live session. The `standard` tier SHALL use `FRIDAY_TEXT_MODEL`, and the `fast` tier SHALL use `FRIDAY_TEXT_MODEL_FAST`, falling back to `FRIDAY_TEXT_MODEL`. Modules SHALL NOT be able to name a model or supply credentials.

#### Scenario: Tier selection
- **WHEN** `FRIDAY_TEXT_MODEL_FAST` is unset and a module asks for tier `fast`
- **THEN** the call uses `FRIDAY_TEXT_MODEL`, and the result names that model

### Requirement: Concurrency is bounded

Core SHALL run at most `FRIDAY_LLM_CONCURRENCY` (default 2) model calls at a time across all modules. Further calls SHALL wait in arrival order.

#### Scenario: Burst of calls
- **WHEN** a module starts 5 calls at once with the default limit
- **THEN** 2 run immediately and the others start as earlier calls finish

### Requirement: Usage is logged without content

Every call SHALL be logged once when it settles, with the calling module's id, the model, the input and output token counts, the latency, and the outcome (`ok`, or the error kind). Prompts, messages and responses SHALL NOT be logged.

#### Scenario: Log line
- **WHEN** module `brain` makes a successful call
- **THEN** one log line names `brain`, the model, the token counts, the duration, and `ok`, and contains none of the prompt text

### Requirement: Text generation is available only in-process

Hosts without a model provider, such as the remote runner, SHALL make `ctx.llm.generate` reject with `unavailable`, stating that text generation is not available in that host.

#### Scenario: Remote module
- **WHEN** a module run through `runRemote` calls `ctx.llm.generate`
- **THEN** the call rejects with `unavailable` and that message
