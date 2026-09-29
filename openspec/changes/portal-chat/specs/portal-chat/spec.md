# Spec Delta

## Purpose

Lets the user type to Friday in the portal as chat threads that can be resumed later. Each message is one streamed turn against a text model, with the same tools as voice and a record in the conversation store.

## ADDED Requirements

### Requirement: A chat turn runs against the chat model

Each chat message SHALL be answered by one turn against a non-Live Gemini text model, using the model from `FRIDAY_CHAT_MODEL`, falling back to `FRIDAY_TEXT_MODEL`, and the Gemini API key resolved from core's configuration for each model call of the turn (as specified in `secret-management`). The turn SHALL send the chat system prompt (the shared base and the chat part), the thread's history, the new message, and the declarations of the tools available in the `chat` channel, read from the registry when the turn starts. The chat part of the prompt SHALL allow markdown and complete answers instead of short spoken ones.

#### Scenario: Model fallback
- **WHEN** `FRIDAY_CHAT_MODEL` is unset and `FRIDAY_TEXT_MODEL` is `gemini-flash-latest`
- **THEN** chat turns use `gemini-flash-latest`

#### Scenario: Tools changed between turns
- **WHEN** an MCP server is added in the portal between two messages of the same thread
- **THEN** the second turn declares that server's tools

#### Scenario: Voice-only tools are not offered
- **WHEN** a chat turn starts
- **THEN** its declarations contain `get_current_time` and do not contain `set_timer` or `end_conversation`

### Requirement: The whole thread is replayed as history

A turn on an existing thread SHALL send every stored entry of that conversation in order. User entries SHALL be sent as user turns and assistant entries as model turns, interrupted ones included with the text that was stored. Each tool entry SHALL be sent as the model's function call with its arguments, followed by the function's response. A result marked truncated SHALL be sent as `{ "truncated": true, "partial": <stored text> }`, and a tool entry without a result as `{ "error": "no result" }`. Thought summaries SHALL NOT be part of the history.

#### Scenario: Resume after days
- **WHEN** a thread asked "is the living room light on?", recorded a tool entry with the answer `on`, and the user sends "turn it off" two days later
- **THEN** the model receives the earlier question, the function call and its response, the earlier answer, and then "turn it off"

#### Scenario: Truncated result
- **WHEN** a stored tool result was cut to 4000 characters
- **THEN** the function response in the history is `{ "truncated": true, "partial": <the 4000 stored characters> }`

### Requirement: Tool calls run in a loop until the model answers

When the model responds with function calls, the turn SHALL call each tool through the registry, restricted to the `chat` channel, send the results back, and ask the model again, until the model responds without function calls. Each tool call SHALL be bounded by `FRIDAY_CHAT_TOOL_TIMEOUT_MS` (default 30000). A call that exceeds it SHALL be answered with `{ "error": "timed out after <ms> ms" }`, and its late result SHALL be discarded. Scheduling hints and `endConversation` requests in results SHALL be ignored. A turn SHALL make at most 10 rounds of tool calls; the model's next function calls SHALL then end the turn with an error of kind `too_many_tool_calls`.

#### Scenario: Two tools, then an answer
- **WHEN** the user asks "turn off the light and find Dune" and the model calls `ha_turn_off`, then `jellyfin_search`, then answers in text
- **THEN** both tools run in that order, each result is sent back to the model, and the turn ends with the text answer

#### Scenario: Hanging tool
- **WHEN** a tool does not settle within `FRIDAY_CHAT_TOOL_TIMEOUT_MS`
- **THEN** the model receives the timeout error as that call's result and the turn continues

#### Scenario: Voice-only tool requested
- **WHEN** the model calls `end_conversation` in a chat turn
- **THEN** the call is answered with `{ "error": "unknown tool end_conversation" }` and nothing is closed

### Requirement: Chat turns are recorded as chat conversations

Every turn SHALL be recorded in the conversation store with channel `chat` and no device: the message as a user entry with input `text`, stored before the model is first called, then assistant entries and tool entries in order. A message without a conversation id SHALL start a new conversation. A message with the id of a chat conversation SHALL append to it, making it active again. After a turn, the conversation SHALL NOT be ended explicitly: it SHALL stay active and go quiet by the inactivity rule. When the answer fails after text was streamed, the streamed text SHALL be stored as an assistant entry marked interrupted.

#### Scenario: New thread
- **WHEN** the user sends a first message without a conversation id
- **THEN** a conversation with channel `chat` is created, holding the user entry and the answer

#### Scenario: Thread stays open between messages
- **WHEN** a turn completes and no message follows for 10 minutes
- **THEN** the conversation is still `active`, and it becomes `quiet` once `FRIDAY_CONVERSATION_QUIET_MINUTES` have passed without activity

#### Scenario: Failure mid-answer
- **WHEN** the model connection fails after "Dune is" was streamed
- **THEN** the conversation holds the user entry and an interrupted assistant entry "Dune is"

### Requirement: Chat API streams the turn

`POST /api/chat` SHALL accept a JSON body `{ "text": <string>, "conversationId"?: <string> }`. An empty or missing `text` SHALL respond 400. A `conversationId` that is unknown or not a `chat` conversation SHALL respond 404. A message for a conversation whose turn is still running SHALL respond 409. Otherwise the response SHALL be a `text/event-stream` in which each event has an event name and a JSON `data` line:
- `start`: `{ conversationId }`, always the first event;
- `thinking`: `{ text }`, a fragment of the model's thought summary;
- `text`: `{ text }`, a fragment of the answer, in order;
- `tool_call`: `{ name, args }`, as soon as the model requests a call;
- `tool_result`: `{ name, result }`, when the call settles or times out;
- `done`: `{ conversationId }`, the last event of a successful turn;
- `error`: `{ kind, message }`, the last event of a failed turn, with the kinds of `module-llm` plus `too_many_tool_calls`.
The server SHALL send a comment line at least every 15 seconds while the turn is running, so that proxies keep the stream open.

#### Scenario: Streamed answer
- **WHEN** the portal posts `{ "text": "what time is it?" }`
- **THEN** the stream carries `start`, `tool_call` for `get_current_time`, its `tool_result`, one or more `text` events, and `done`, in that order

#### Scenario: Busy thread
- **WHEN** a second message is posted for a conversation while its first turn is still streaming
- **THEN** the response is 409 and the first turn is unaffected

#### Scenario: Voice conversation id
- **WHEN** a message is posted with the id of a `voice` conversation
- **THEN** the response is 404 and nothing is recorded

#### Scenario: Model unavailable
- **WHEN** the Gemini API key is not configured
- **THEN** the stream carries `start` and then `error` with kind `unavailable`, and the user entry is stored

### Requirement: A turn outlives its client

When the client disconnects during a turn, the turn SHALL continue to completion, including its tool calls, and SHALL be recorded as if the client were connected. Events after the disconnect SHALL be dropped.

#### Scenario: Page reloaded mid-turn
- **WHEN** the user reloads the Chat page while a tool call is running
- **THEN** the tool call completes, the answer is recorded, and opening the thread afterwards shows it

### Requirement: Chat model calls follow the text-model policy

Each model call in a chat turn SHALL take a slot of the shared text-model concurrency bound for as long as it streams, SHALL be bounded by `FRIDAY_LLM_TIMEOUT_MS`, and SHALL map failures to the error kinds of `module-llm`. Failures before the call has produced any output SHALL be retried with the `module-llm` retry policy. A failure after output SHALL NOT be retried and SHALL end the turn with an `error` event. Each call SHALL be logged once when it settles in the `module-llm` format with caller `chat`, without prompts, history or answers.

#### Scenario: Rate limit before output
- **WHEN** the first attempt of a chat model call gets a 429 with a 3-second wait
- **THEN** the call is retried after 3 seconds, the stream continues normally, and the log line records the failed attempt

#### Scenario: Failure after output
- **WHEN** the model connection fails after text was streamed
- **THEN** the call is not retried and the stream ends with `error` of kind `unavailable`

### Requirement: Chat page

The portal SHALL provide a `Chat` page at `/chat` (a new thread) and `/chat/:id` (an existing chat thread). It SHALL list chat conversations, most recent activity first, with their preview and last activity, with a `New chat` action and loading of more threads on request. The selected thread's stored entries SHALL be shown in order: user messages, assistant answers rendered as markdown (interrupted ones marked), and tool entries collapsed to their name and expandable to arguments and result. While a turn streams, the page SHALL show thought summaries dimmed and collapsible, answer text as it arrives, and tool calls as they start and settle. The message input SHALL send on Enter, insert a newline on Shift+Enter, and be disabled while a turn runs. After the first message of a new thread, the URL SHALL become `/chat/<id>`. A failed turn SHALL show its error below any partial answer. An unknown or non-chat id SHALL show a "not found" notice with a link to a new chat. At widths down to 360 px the thread list SHALL collapse into a menu.

#### Scenario: Continue an old thread
- **WHEN** the user opens a chat thread from last week and sends a message
- **THEN** the earlier messages are shown, the new answer streams below them, and the thread moves to the top of the list

#### Scenario: New thread gets a URL
- **WHEN** the user sends a first message on `/chat`
- **THEN** the URL becomes `/chat/<id>` for the new conversation and the thread appears in the list

### Requirement: Model output is rendered without raw HTML

Markdown in assistant answers SHALL be rendered with raw HTML disabled, so HTML in model output is shown as text and never executed. Links SHALL open in a new tab without access to the opener.

#### Scenario: HTML in an answer
- **WHEN** an answer contains `<img src=x onerror=alert(1)>`
- **THEN** the text is shown literally and no script runs
