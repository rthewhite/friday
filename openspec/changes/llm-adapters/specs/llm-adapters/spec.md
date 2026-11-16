# Spec Delta

## Purpose

Lets core's text generation (portal chat, agent runs and `ctx.llm`) run on more than one model provider. Core speaks one provider-neutral format, and an adapter per provider translates it: one for Gemini, and one for any server with an OpenAI-compatible chat completions API.

## ADDED Requirements

### Requirement: Text generation goes through a provider-neutral model interface

Portal chat turns, agent runs and `ctx.llm` calls SHALL reach the model only through one provider-neutral model interface. It offers a one-shot call and a streamed call with tools, and an adapter per provider implements it. Swapping the adapter SHALL NOT change how chat, agents or `ctx.llm` behave, apart from what the provider itself answers. Voice sessions on the Live model SHALL NOT use this interface.

#### Scenario: Chat turn on another adapter
- **WHEN** a chat turn in which the model calls `get_current_time` and then answers runs on the OpenAI-compatible adapter against a test server
- **THEN** the tool runs, its result goes back to the model, and the turn streams, records and ends exactly as it does on the Gemini adapter

#### Scenario: Module call on another adapter
- **WHEN** a module's `ctx.llm.generate` call with a JSON schema runs on the OpenAI-compatible adapter
- **THEN** it resolves with validated `json`, and its failures carry the same error kinds as on the Gemini adapter

#### Scenario: Voice is not affected
- **WHEN** a voice session opens
- **THEN** it talks to the Live model directly, as before

### Requirement: Messages and tool calls are provider-neutral

A request SHALL consist of an optional system instruction, an ordered list of messages with the role `user`, `assistant` or `tool`, and optional tool declarations. An assistant message SHALL carry text, tool calls, or both. Every tool call SHALL have a name, an object of arguments, and an id that is unique within the request. A tool message SHALL answer exactly one earlier tool call of that request, naming its id and the tool, and SHALL carry the result as a JSON object. A message MAY carry provider data that only the adapter which produced it reads. Other adapters, and the rest of core, SHALL ignore it.

#### Scenario: Replayed thread gets call ids
- **WHEN** a chat thread with two stored tool entries is replayed
- **THEN** each stored call is sent with an id of its own, followed by a tool message with that id and its stored result

#### Scenario: Parallel calls in one round
- **WHEN** the model asks for `ha_turn_off` and `jellyfin_search` in one round
- **THEN** the two calls get different ids, and each result goes back in its own tool message with the id of its call

#### Scenario: Provider data stays with its adapter
- **WHEN** an assistant message produced by the Gemini adapter carries provider data and is sent through the OpenAI-compatible adapter
- **THEN** the OpenAI-compatible adapter sends the message's text and tool calls and leaves the provider data out

### Requirement: Streamed calls yield text, thoughts and complete tool calls

A streamed call SHALL yield, in the order the provider sends them, pieces of answer text, pieces of thought summary (only when the request asks for thoughts), and tool calls. A tool call SHALL be yielded only once its name and all of its arguments have arrived. The call SHALL end with a finish reason and the token usage. The finish reason SHALL be one of:
- `stop`: the model finished, with or without tool calls;
- `length`: the output limit cut the answer off;
- `malformed_call`: the model produced a tool call that could not be read;
- `other`: anything else, carrying the provider's own reason.

A response that the provider blocked SHALL reject with `blocked` instead of ending. When the provider reports no usage, the input and output token counts SHALL be 0.

#### Scenario: Arguments arrive in pieces
- **WHEN** the provider streams the arguments of one tool call over five chunks
- **THEN** the call is yielded once, with all of its arguments

#### Scenario: Cut off at the output limit
- **WHEN** the model reaches the output limit without calling a tool
- **THEN** the call ends with `length`, and a chat turn reports that the answer was cut off at the output limit, as before

#### Scenario: No usage reported
- **WHEN** an OpenAI-compatible server ends a stream without usage
- **THEN** the call ends with 0 input and 0 output tokens

### Requirement: Provider failures map to neutral kinds

Each adapter SHALL map its provider's failures to neutral failures that core's retry and error handling act on, without reading provider-specific details:
- rate-limited, with the wait the provider asks for when it states one, and whether the exhausted quota is a daily quota when the provider says so;
- temporarily unavailable: HTTP 408, 500, 502, 503 or 504, or the server could not be reached;
- invalid request: HTTP 400, 404 or 422;
- blocked: the provider refused the prompt or stopped the response for safety or policy, with the provider's reason;
- any other failure, which is not retried.

The resulting error kinds, retries and log lines SHALL be those specified in `module-llm`, whichever adapter is in use. Error messages and log lines SHALL NOT contain API keys.

#### Scenario: Gemini rate limit with a stated wait
- **WHEN** Gemini answers HTTP 429 with a `RetryInfo` of 37 seconds
- **THEN** core waits about 37 seconds before the next attempt, as before

#### Scenario: OpenAI-compatible rate limit with a stated wait
- **WHEN** an OpenAI-compatible server answers HTTP 429 with `Retry-After: 37`
- **THEN** core waits about 37 seconds before the next attempt

#### Scenario: Wrong key
- **WHEN** an OpenAI-compatible server answers HTTP 401
- **THEN** the call rejects with `unavailable` after one attempt, and the message doesn't contain the key

#### Scenario: Server down
- **WHEN** the server's address refuses connections on every attempt
- **THEN** the call rejects with `unavailable` after 3 attempts in total

### Requirement: The Gemini adapter keeps Gemini's behaviour

The Gemini adapter SHALL send requests to Gemini as core did before this change: the same system instruction, tool declarations (Gemini parameter schemas as they are, raw JSON Schemas as JSON Schemas), structured output settings and thought settings. Within one chat turn or agent run, the model's own turns SHALL go back to Gemini with their parts unchanged, thought signatures included. Thought summaries SHALL be yielded as thoughts and SHALL NOT be sent back. Gemini's finish reasons SHALL map as follows: `STOP` to `stop`, `MAX_TOKENS` to `length`, `MALFORMED_FUNCTION_CALL` to `malformed_call`, and the safety and policy reasons to `blocked`. Any other reason SHALL map to `other` with Gemini's reason.

#### Scenario: Thought signature within a turn
- **WHEN** Gemini returns a tool call with a thought signature and the tool's result is sent back in the same turn
- **THEN** the model turn sent back contains that call with its thought signature, unchanged

#### Scenario: Safety stop
- **WHEN** Gemini ends a response with finish reason `SAFETY`
- **THEN** the call rejects with `blocked` and the reason `SAFETY`

### Requirement: The OpenAI-compatible adapter speaks chat completions

The OpenAI-compatible adapter SHALL be configured with a base URL and an optional API key. It SHALL send every call as an HTTP POST to `<base URL>/chat/completions` with:
- the system instruction as the first message, with role `system`;
- assistant tool calls as `tool_calls` of type `function`, whose arguments are a JSON string, and tool results as messages with role `tool`, the call's `tool_call_id`, and the result as JSON text;
- tool declarations as tools of type `function`. A raw JSON Schema is sent as it is. A Gemini parameter schema is converted to JSON Schema: type names in lower case, `nullable` as a union with `null`, and `description`, `enum`, `format`, `properties`, `required` and `items` kept. A tool without parameters gets an object schema without properties;
- for structured output, `response_format` of type `json_schema` with the request's schema;
- for streamed calls, `stream: true` with usage included.

The API key, when set, SHALL be sent as a bearer token in the `Authorization` header. Without a key the header SHALL be left out. A streamed response SHALL be read as server-sent events until `[DONE]`. A tool call's arguments that are not valid JSON SHALL end the call with `malformed_call`. The finish reason `content_filter` SHALL reject with `blocked`. Reasoning output that some servers add SHALL be ignored: it is neither yielded nor sent back.

#### Scenario: Local server without a key
- **WHEN** the adapter is configured with `http://gpu-box:11434/v1` and no key
- **THEN** it posts to `http://gpu-box:11434/v1/chat/completions` without an `Authorization` header

#### Scenario: SDK schema converted
- **WHEN** a tool declares `{ type: "OBJECT", properties: { when: { type: "STRING", nullable: true } }, required: [] }`
- **THEN** the tool is sent with `{ "type": "object", "properties": { "when": { "type": ["string", "null"] } }, "required": [] }`

#### Scenario: Structured output
- **WHEN** a one-shot call asks for output matching a JSON schema
- **THEN** the request carries `response_format` of type `json_schema` with that schema, and the answer's text is returned for validation

#### Scenario: Unreadable tool arguments
- **WHEN** the server streams a tool call whose arguments are `{"when": ` and then finishes
- **THEN** the call ends with `malformed_call`, and a chat turn reports a malformed tool call, as on Gemini

#### Scenario: Reasoning output ignored
- **WHEN** the server streams `reasoning_content` before its answer
- **THEN** only the answer text is yielded
