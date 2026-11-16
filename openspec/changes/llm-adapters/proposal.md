# Proposal

> From an explore session on 2026-11-06 to 2026-11-16. This is the first of a series. `llm-providers` (providers and models stored in `friday.db`, a Settings > Models page, routing per role, module and agent) builds on it.

## Why

Friday uses Gemini for everything, and the text path is tied to it. `tool-loop.ts`, the chat engine, chat history and the agent runtime all use `Content`, `Part` and `FunctionDeclaration` from `@google/genai`. `LlmService` reads Gemini's rate-limit and safety details. We want smaller models on our own hardware for background work, starting with the brain's nightly runs and agents, to save costs and keep data in the house. That needs a text layer that doesn't depend on any one provider, with an adapter per provider. This change builds that layer and an OpenAI-compatible adapter next to the Gemini one, without changing what Friday does yet.

## What Changes

- **Provider-neutral messages.** Core gets its own message types, shaped like OpenAI's chat format: roles `system`, `user`, `assistant` and `tool`; tool calls with ids; JSON Schema for tool parameters and structured output. They are Friday's own types. Neither `@google/genai` nor `openai` types are used outside the adapters.
- **One model interface, implemented by adapters.** It has a one-shot call (`generate`) and a streamed call with tools (`stream`), and replaces today's `TextModel`. Each adapter maps the neutral types to its provider, and the provider's failures to neutral ones: rate-limited (with the wait time the provider asks for, and whether a daily quota ran out), blocked, unavailable, invalid request.
- **Gemini adapter.** Today's behaviour moves behind the interface unchanged. Gemini's extras are kept in an opaque field on the message: thought signatures that must go back unchanged within a turn, thought summaries, and block reasons. The rest of core never reads that field.
- **OpenAI-compatible adapter.** Chat completions over HTTP with `tools`, `stream: true` and `response_format: json_schema`, so it works with Ollama, vLLM, llama.cpp and similar servers, and OpenAI itself. It converts the SDK's tool schemas (`Type.OBJECT` and so on) to JSON Schema and takes `parametersJsonSchema` as it is. A single contract test suite runs against both adapters.
- **Core moves off `@google/genai` for text.** `tool-loop.ts`, `chat/engine.ts`, `chat/history.ts`, `agents/runtime.ts` and `LlmService` use only the neutral types. `LlmService` keeps the queue, retries, timeouts, validation and logging. Its retry decisions are based on the neutral failures.
- **History replay makes up tool call ids.** Stored tool entries have no call id, so replay gives each call an id and pairs it with its result. The stored format doesn't change.
- **Nothing selects the OpenAI-compatible adapter yet.** Chat, agents and `ctx.llm` keep running on Gemini with today's environment variables, models and key. That comes in `llm-providers`.

Out of scope, each part of a later change:
- Configuring providers and models, assigning models to roles, modules and agents, and per-provider concurrency (`llm-providers`). One decision is already made there: when a model is unreachable, the run or job fails, with no fallback to another model.
- A model picker in the chat window.
- File parts (PDF, images) in prompts. `document-store` adds those to the neutral types.
- Voice. `session.ts` stays on Gemini Live, which is a separate real-time audio protocol.
- Reasoning output from OpenAI-compatible servers (`reasoning_content` and similar), which differs per server.
- Changing the SDK's tool contract. Modules keep declaring tools exactly as they do today.

## Capabilities

### New Capabilities

- `llm-adapters`: the provider-neutral message and tool types, the model interface, the neutral failure kinds, and what the Gemini and OpenAI-compatible adapters guarantee. That covers thought signatures within a turn, tool schema conversion, streamed tool calls, structured output, made-up tool call ids on replay, and how each provider's errors are mapped.

### Modified Capabilities

- `module-llm`: "Core owns the provider, the key and the models" no longer requires `@google/genai` directly. `ctx.llm` is served through the model interface, and the Gemini adapter is the one in use. Tiers, key resolution and the rule that modules can't name a model or supply credentials stay the same.

## Impact

- `packages/core/src/llm/`: `gemini.ts` becomes the Gemini adapter. New neutral types, the model interface and the OpenAI-compatible adapter are added. `service.ts` loses its Gemini-specific error parsing (`classify`, `rateLimitInfo`, `BLOCKING_FINISH`) to the adapters. `tool-loop.ts` uses neutral types.
- `packages/core/src/chat/engine.ts`, `chat/history.ts`, `agents/runtime.ts`, and the wiring in `app.ts`.
- Tests: `llm*.test.ts`, `tool-loop.test.ts`, the chat and agent tests, and a new shared adapter contract suite with a fake OpenAI-compatible server.
- `packages/core/src/session.ts` (voice) and `packages/sdk` are not changed. No module changes.
- Dependencies: `@google/genai` stays for the Gemini adapter and voice. The OpenAI-compatible adapter is planned over `fetch` with server-sent events, without the `openai` package. The design confirms this.
- No configuration, migration or deploy changes. The deploy is not risky.
- Other changes in flight: `document-store` changes `module-llm` too (file parts). If this change merges first, its file parts go into the neutral types instead of Gemini `Part`s.
