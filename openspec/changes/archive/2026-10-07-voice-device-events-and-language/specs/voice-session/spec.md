## MODIFIED Requirements

### Requirement: System prompt defines Friday's persona and end-of-conversation policy

The voice system prompt SHALL consist of, in order:
1. the shared base prompt, which is also used by chat,
2. the voice part,
3. the module context for channel `voice` (as specified in `module-system`), when it is not empty,
4. when the session belongs to a registered voice device (as specified in `voice-devices`), a device block.

The module context and the device block SHALL be rendered when the session opens and SHALL stay fixed for the session's lifetime.

The base SHALL instruct the model to prefer tools over guessing and answer in the user's language. It SHALL state that the user speaks Dutch or English, and that the model answers in the language they speak unless they ask for another one. It SHALL NOT force one language: English is answered in English.

The voice part SHALL say that speech recognition sometimes takes Dutch for another language: when a whole utterance seems to be in a language other than Dutch or English, the model treats it as misheard Dutch and answers in Dutch. Names, titles and quoted words in another language SHALL NOT count. This rule SHALL NOT be part of the base, because typed chat cannot be misheard.

The voice part SHALL instruct the model to keep spoken answers short, call `end_conversation` in the same turn as its final confirmation or goodbye, and NOT end while awaiting user input or a pending tool result. It SHALL also state that the model must never call `end_conversation` in a turn whose reply ends with a question or invites the user to talk, and that an invitation to chat, tell something or share information starts an open conversation rather than completing a request.

The device block SHALL:
- name the device's label,
- when the device has an area, state that the user is in that Home Assistant area and that requests which name no room, area or floor (such as turning on "the lights") apply to that area,
- include the device's notes when it has any.

#### Scenario: Request fully handled
- **WHEN** the model has completed a request and has no follow-up question
- **THEN** it is instructed to confirm briefly and call `end_conversation` in the same turn

#### Scenario: Clarification needed
- **WHEN** the model still needs information from the user
- **THEN** it is instructed not to call `end_conversation`

#### Scenario: Reply ends with a question
- **WHEN** the model's reply ends with a question or invites the user to talk
- **THEN** it is instructed not to call `end_conversation` in that turn

#### Scenario: Invitation to talk
- **WHEN** the user asks Friday to have a conversation or offers to share something
- **THEN** the prompt treats it as an open conversation, not a finished request

#### Scenario: Dutch or English
- **WHEN** the user speaks English
- **THEN** the model is instructed to answer in English, and when the user speaks Dutch, in Dutch

#### Scenario: Misheard language
- **WHEN** the input transcription of a whole utterance in a voice session looks like another language, such as Spanish
- **THEN** the model is instructed to treat it as Dutch and answer in Dutch

#### Scenario: Foreign names and explicit requests
- **WHEN** the user says "play Despacito" or asks for an answer in German
- **THEN** the foreign name doesn't count as another language, and the answer is in German because the user asked for it

#### Scenario: Typed chat in another language
- **WHEN** the user types a chat message in German
- **THEN** the chat prompt has no misheard-language rule, and the model answers in German

#### Scenario: Shared base
- **WHEN** the voice and chat system prompts are compared
- **THEN** both start with the same base, and only the voice prompt mentions `end_conversation`

#### Scenario: Module context in a voice session
- **WHEN** module `brain` provides context and a voice session opens
- **THEN** the session's system instruction is the base, the voice part, and then the `brain` context

#### Scenario: Context changes during a session
- **WHEN** a provider's output changes while a voice session is open
- **THEN** the open session keeps its instruction, and the next session uses the new output

#### Scenario: No module context
- **WHEN** no provider returns text and the session has no device
- **THEN** the system instruction is the base and the voice part only

#### Scenario: Device with an area
- **WHEN** registered device `Kitchen satellite` with area `Kitchen` and notes `Next to the fridge` opens a session
- **THEN** the system instruction ends with a device block naming `Kitchen satellite`, stating that requests without a room apply to the area `Kitchen`, and including `Next to the fridge`

#### Scenario: Device without an area
- **WHEN** a registered device with no area and no notes opens a session
- **THEN** the device block names the device's label and states no default area

#### Scenario: Session without a device
- **WHEN** the portal's Talk page opens a session without a device
- **THEN** the system instruction has no device block

#### Scenario: Device edited during a session
- **WHEN** a device's area is changed while it has a session open
- **THEN** the open session keeps its device block, and the next session uses the new area
