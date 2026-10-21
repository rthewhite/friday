# Spec Delta

## MODIFIED Requirements

### Requirement: Concurrency is bounded

Core SHALL run at most `FRIDAY_LLM_CONCURRENCY` (default 2) text-model calls at a time across all modules, chat turns and agent runs. A chat model call SHALL hold its slot for as long as it streams. Further calls SHALL wait in arrival order. Model calls of agent runs SHALL together hold at most one slot at a time: an agent call SHALL wait for the other agent calls to finish before it waits for a slot, so with two or more slots, chat and modules always have a slot that agents cannot take.

#### Scenario: Burst of calls
- **WHEN** a module starts 5 calls at once with the default limit
- **THEN** 2 run immediately and the others start as earlier calls finish

#### Scenario: Chat and a module share the bound
- **WHEN** a module has 2 calls running with the default limit and a chat message arrives
- **THEN** the chat model call starts as soon as one of the module calls finishes

#### Scenario: Agents leave a slot for chat
- **WHEN** two agents are running with the default limit and a chat message arrives
- **THEN** one agent model call is in flight, the other agent waits, and the chat model call starts at once
