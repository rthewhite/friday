## ADDED Requirements

### Requirement: Conversations record their user

A conversation SHALL record the user it belongs to, when there is one: the user of a chat thread, the user of a browser voice session, and the user who started an agent run. A voice device's conversation and a scheduled agent run's conversation SHALL have no user. Conversations stored before users existed SHALL keep having no user. A chat thread SHALL keep the user who started it, also when it is continued later. `GET /api/conversations` and `GET /api/conversations/:id` SHALL include `user` (`{ id, name }`, or `null`). Listing, reading, searching and deleting SHALL NOT be filtered by user.

#### Scenario: Chat
- **WHEN** member `u2` starts a chat thread
- **THEN** the conversation records user `u2`, and the API lists it with `user: { id: "u2", name }`

#### Scenario: Voice device
- **WHEN** device `friday-kitchen` holds a conversation
- **THEN** the conversation has no user

#### Scenario: Not filtered
- **WHEN** members `u1` and `u2` each have a chat thread and `u1` lists conversations
- **THEN** both threads are listed
