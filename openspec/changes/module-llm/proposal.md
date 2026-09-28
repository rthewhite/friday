# Proposal

## Why

The only model Friday talks to is Gemini Live, bound to one voice session. Work that happens outside a conversation has no model to call. The nightly brain pass reading transcripts is the first example, and summaries or classification in modules are likely next. Giving each module its own API key and SDK wiring would scatter model choice, credentials and cost. Core already holds the Gemini key, so it should offer text generation to modules as a platform service. Follows `background-jobs` and `conversation-store`, whose jobs will be its main callers.

## What Changes

- Modules get `ctx.llm.generate(...)`: a system instruction, a prompt or list of messages, and an optional output schema. It resolves to text, or to JSON parsed and validated against the schema.
- **Structured output is checked, not trusted.** When a schema is given, a response that fails to parse or validate is an error (`invalid_output`), never an empty result. A caller can tell "the model found nothing" apart from "the model answered badly".
- Failures are typed: `unavailable` (the model cannot be reached, is rate-limited or timed out, after a small number of retries for transient errors), `invalid_output`, `blocked` (the provider refused the prompt or stopped for safety), `invalid_request` (for example an invalid schema), and `cancelled`. Calls take an abort signal, so a job being stopped cancels its model calls.
- Core owns the provider (Gemini via `@google/genai`, non-Live), the key, and the default text model (`FRIDAY_TEXT_MODEL`). A module may ask for a model tier rather than naming a model.
- Core bounds concurrent calls, and logs every call with owner, model, token usage and latency.
- `createTestHost` accepts a fake model, so module logic that uses `ctx.llm` is testable without network access.
- Remote modules do not get `ctx.llm`. They bring their own model if they need one.

Out of scope: tool use by the text model and multi-turn chat sessions (the portal chat engine is a later change, which can build on this provider), streaming responses, non-Gemini providers, and cost dashboards or quotas.

## Capabilities

### New Capabilities
- `module-llm`: the `ctx.llm` contract, structured output validation, error kinds, cancellation, provider and model configuration, the concurrency bound, and usage logging.

### Modified Capabilities
- `module-system`: `ModuleContext` gains `llm` for in-process modules, and the test host accepts a fake model.

## Impact

- `packages/sdk`: the `ModuleContext.llm` types, and the error types modules can check for, plus a fake model in `@friday/sdk/test`.
- `packages/core`: a text-generation provider (e.g. `src/llm/`), wired into the module context. Reuses the existing Gemini key.
- Config: `FRIDAY_TEXT_MODEL` and a concurrency limit, documented in `.env.example`.
- Cost: background model calls now happen without anyone talking. Usage is visible in logs from day one.
