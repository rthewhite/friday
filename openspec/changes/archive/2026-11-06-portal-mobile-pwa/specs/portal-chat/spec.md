# Spec Delta

## MODIFIED Requirements

### Requirement: Chat page

The portal SHALL provide a `Chat` page at `/chat` (a new thread) and `/chat/:id` (an existing chat thread). It SHALL list the logged-in user's chat conversations, most recent activity first, with their preview and last activity, with a `New chat` action and loading of more threads on request. The selected thread's stored entries SHALL be shown in order: user messages, assistant answers rendered as markdown (interrupted ones marked), and tool entries collapsed to their name and expandable to arguments and result. While a turn streams, the page SHALL show thought summaries dimmed and collapsible, answer text as it arrives, and tool calls as they start and settle. The message input SHALL send on Enter, insert a newline on Shift+Enter, and be disabled while a turn runs. After the first message of a new thread, the URL SHALL become `/chat/<id>`. A failed turn SHALL show its error below any partial answer. An unknown, non-chat or other user's id SHALL show a "not found" notice with a link to a new chat.

Below 768 px wide, down to 360 px:
- **Thread list:** the thread list SHALL be a panel that a `Threads` button slides in over the thread, which closes when a thread or `New chat` is chosen, the backdrop is tapped or Escape is pressed.
- **Layout:** the page SHALL fill the screen below the portal's top bar: the thread's header at the top, the messages scrolling between them, and the message input at the bottom. When the on-screen keyboard opens, the message input SHALL stay directly above the keyboard, and the top bar and the thread's header SHALL stay in view. Scrolling the messages SHALL NOT scroll or refresh the page.
- **Message input:** it SHALL use at least 16 px text, so that focusing it does not zoom the page. It SHALL start one line high and grow with its text up to a limit, after which it scrolls. Its placeholder SHALL be short and not mention Shift+Enter, and the keyboard's return key SHALL be labelled as sending.
- **Send button:** it SHALL be a round icon button as tall as the one-line message input, beside it, with `Send` as its accessible name.

From 768 px wide, the thread list, the message input and the `Send` button SHALL be shown as before this change.

#### Scenario: Continue an old thread
- **WHEN** the user opens a chat thread from last week and sends a message
- **THEN** the earlier messages are shown, the new answer streams below them, and the thread moves to the top of the list

#### Scenario: New thread gets a URL
- **WHEN** the user sends a first message on `/chat`
- **THEN** the URL becomes `/chat/<id>` for the new conversation and the thread appears in the list

#### Scenario: Focus the message input on a phone
- **WHEN** the user taps the message input on an iPhone
- **THEN** the page does not zoom, the keyboard opens with the message input directly above it, and the portal's top bar and the thread's title are still visible

#### Scenario: Send button on a phone
- **WHEN** the Chat page is shown 390 px wide
- **THEN** the send button is a round icon button as tall as the message input beside it, and a screen reader announces it as `Send`

#### Scenario: Longer message on a phone
- **WHEN** the user types a message of four lines on a phone
- **THEN** the message input grows to show the four lines without a resize handle

#### Scenario: Pick a thread on a phone
- **WHEN** the user taps `Threads` on a phone and chooses a thread
- **THEN** the thread list slides over the thread, closes when the thread is chosen, and the chosen thread is shown

#### Scenario: Desktop composer unchanged
- **WHEN** the Chat page is shown 1280 px wide
- **THEN** the thread list is a column beside the thread, and the message input is two lines high with the placeholder that mentions Shift+Enter, next to a `Send` button with its label
