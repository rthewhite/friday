# Spec Delta

## MODIFIED Requirements

### Requirement: Extraction reads each finished conversation once

Extraction SHALL consider the conversations that went quiet after its watermark, oldest first, at most `BRAIN_NIGHTLY_MAX_CONVERSATIONS` (default 30) per run, after first retrying conversations that failed on earlier runs. For each conversation it SHALL:
- extract only from entries added since that conversation was last processed, showing earlier entries as context only;
- skip, without a model call, entries whose user text totals fewer than 4 words;
- remember how far it got and advance the watermark once the conversation has been handled.

Conversations on the `agent` channel SHALL be passed over without a model call: their text comes from tools and the agent's instructions, not from the user. They SHALL NOT count toward the limit or as handled or skipped, and the watermark SHALL move past them.

On a first run without a watermark, it SHALL start from the oldest retained conversation. Conversations that are active SHALL NOT be read.

#### Scenario: Backlog
- **WHEN** the first run finds 70 quiet conversations and the limit is 30
- **THEN** it handles the 30 oldest, and the next two runs handle the rest

#### Scenario: Resumed conversation
- **WHEN** a conversation with 10 processed entries is resumed with 4 more and goes quiet again
- **THEN** the next run extracts only from the 4 new entries, with the first 10 shown as context

#### Scenario: Trivial conversation
- **WHEN** a conversation's only user entry is "pause"
- **THEN** it is counted as skipped and no model call is made for it

#### Scenario: Agent run
- **WHEN** an agent run's conversation, whose tool results say "the user's sister is called Anouk", went quiet after the watermark
- **THEN** no model call is made for it, no note is added, and the next run does not consider it again
