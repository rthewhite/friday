# Spec Delta

## MODIFIED Requirements

### Requirement: Concurrency is bounded

Core SHALL run at most `FRIDAY_LLM_CONCURRENCY` (default 2) text-model calls at a time across all modules and chat turns. A chat model call SHALL hold its slot for as long as it streams. Further calls SHALL wait in arrival order.

#### Scenario: Burst of calls
- **WHEN** a module starts 5 calls at once with the default limit
- **THEN** 2 run immediately and the others start as earlier calls finish

#### Scenario: Chat and a module share the bound
- **WHEN** a module has 2 calls running with the default limit and a chat message arrives
- **THEN** the chat model call starts as soon as one of the module calls finishes
