# Spec Delta

## MODIFIED Requirements

### Requirement: Conversations page

The portal SHALL provide a `Conversations` page at `/conversations` with one table row per conversation: state dot, start time, channel, device, preview, entry count, and duration. For a conversation whose device is registered (as specified in `voice-devices`), the device SHALL be shown by its label, with its id available on hover; other devices SHALL be shown by their id. The page SHALL load more rows on request. Clicking a row SHALL open a drawer showing the transcript in order: user entries marked as spoken or typed, assistant entries (with interruptions marked), and tool entries collapsed to their name and expandable to arguments and result. It SHALL also show the device as in the table, the end reason and a `Delete` action that asks for confirmation. For a chat conversation, the drawer SHALL also offer `Open in Chat`, which navigates to `/chat/<id>`. `?id=` SHALL open the drawer for that conversation.

#### Scenario: Read a conversation
- **WHEN** the user opens a voice conversation that used a tool
- **THEN** the drawer shows the spoken question, the collapsed tool entry, and the answer, in order

#### Scenario: Delete
- **WHEN** the user deletes a conversation and confirms
- **THEN** it disappears from the list and `GET /api/conversations/:id` responds 404

#### Scenario: Open a chat thread
- **WHEN** the user opens a chat conversation's drawer and chooses `Open in Chat`
- **THEN** the portal shows `/chat/<id>` with that thread ready for a new message

#### Scenario: Voice conversations cannot be continued
- **WHEN** the user opens a voice conversation's drawer
- **THEN** no `Open in Chat` action is shown

#### Scenario: Registered device shown by label
- **WHEN** a conversation was recorded from device `friday-kitchen`, registered with label `Kitchen satellite`
- **THEN** its row and drawer show `Kitchen satellite`, and hovering shows `friday-kitchen`

#### Scenario: Unregistered device
- **WHEN** a conversation was recorded from a device id that is no longer registered
- **THEN** its row shows the id
