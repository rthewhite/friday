# Spec Delta

## MODIFIED Requirements

### Requirement: Core owns the provider, the key and the models

Core SHALL serve `ctx.llm` through its provider-neutral model interface (as specified in `llm-adapters`), separately from the Live session. The interface SHALL be served by the Gemini adapter, using the Gemini API key resolved from core's configuration on each call (as specified in `secret-management`). The `standard` tier SHALL use `FRIDAY_TEXT_MODEL`, and the `fast` tier SHALL use `FRIDAY_TEXT_MODEL_FAST`, falling back to `FRIDAY_TEXT_MODEL`. Modules SHALL NOT be able to name a model, choose a provider, or supply credentials.

#### Scenario: Tier selection
- **WHEN** `FRIDAY_TEXT_MODEL_FAST` is unset and a module asks for tier `fast`
- **THEN** the call uses `FRIDAY_TEXT_MODEL`, and the result names that model

#### Scenario: Key changed in the portal
- **WHEN** a new `GEMINI_API_KEY` is saved for scope `core`
- **THEN** the next `ctx.llm` call authenticates with the new key, without a restart

#### Scenario: Provider is not the module's choice
- **WHEN** a module passes a provider name or an API key in its request
- **THEN** they are not used: the call goes through the Gemini adapter with core's key
