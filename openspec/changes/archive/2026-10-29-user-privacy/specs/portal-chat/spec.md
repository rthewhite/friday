## MODIFIED Requirements

### Requirement: Chat API streams the turn

`POST /api/chat` SHALL accept a JSON body `{ "text": <string>, "conversationId"?: <string> }`. A body over 100 kB SHALL respond 413. An empty or missing `text` SHALL respond 400. A `conversationId` that is unknown, not a `chat` conversation, or another user's conversation SHALL respond 404. A message for a conversation whose turn is still running SHALL respond 409. Otherwise the response SHALL be a `text/event-stream` in which each event has an event name and a JSON `data` line:
- `start`: `{ conversationId }`, always the first event;
- `thinking`: `{ text }`, a fragment of the model's thought summary;
- `text`: `{ text }`, a fragment of the answer, in order;
- `tool_call`: `{ id, name, args }`, as soon as the model requests a call, where `id` numbers the turn's calls from 1;
- `tool_result`: `{ id, name, result }`, when the call settles or times out, carrying the `id` of its call (parallel calls settle in any order);
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

#### Scenario: Another user's thread
- **WHEN** member `Sanne` posts a message with the id of the owner's chat thread
- **THEN** the response is 404 and nothing is recorded

### Requirement: Chat page

The portal SHALL provide a `Chat` page at `/chat` (a new thread) and `/chat/:id` (an existing chat thread). It SHALL list the logged-in user's chat conversations, most recent activity first, with their preview and last activity, with a `New chat` action and loading of more threads on request. The selected thread's stored entries SHALL be shown in order: user messages, assistant answers rendered as markdown (interrupted ones marked), and tool entries collapsed to their name and expandable to arguments and result. While a turn streams, the page SHALL show thought summaries dimmed and collapsible, answer text as it arrives, and tool calls as they start and settle. The message input SHALL send on Enter, insert a newline on Shift+Enter, and be disabled while a turn runs. After the first message of a new thread, the URL SHALL become `/chat/<id>`. A failed turn SHALL show its error below any partial answer. An unknown, non-chat or other user's id SHALL show a "not found" notice with a link to a new chat. At widths down to 360 px the thread list SHALL collapse into a menu.

#### Scenario: Continue an old thread
- **WHEN** the user opens a chat thread from last week and sends a message
- **THEN** the earlier messages are shown, the new answer streams below them, and the thread moves to the top of the list

#### Scenario: New thread gets a URL
- **WHEN** the user sends a first message on `/chat`
- **THEN** the URL becomes `/chat/<id>` for the new conversation and the thread appears in the list
