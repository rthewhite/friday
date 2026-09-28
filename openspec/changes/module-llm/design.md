# Design

## Context

Core uses `@google/genai` 2.24 only for `live.connect` (`packages/core/src/session.ts`), with `GEMINI_API_KEY` from `settings`. The same SDK offers `models.generateContent` with `systemInstruction`, `responseMimeType` / `responseJsonSchema`, `abortSignal`, `usageMetadata`, `promptFeedback.blockReason`, and per-candidate `finishReason`. Errors surface as `ApiError` with an HTTP `status`. `ajv@8` is already in the dependency tree through `@modelcontextprotocol/sdk`. After `background-jobs`, jobs get an abort signal that should flow into model calls. See `proposal.md` for motivation and `specs/` for behaviour.

## Goals / Non-Goals

**Goals:**
- One contract (`ctx.llm`) that behaves identically in core and in the test host, including validation, so module tests prove real failure handling.
- A core-internal `TextModel` provider that a later portal chat engine can reuse.

**Non-Goals:**
- Tool calling, streaming, caching, or model routing beyond two tiers.
- Persisted usage accounting. Logs are enough until there is a cost question to answer.

## Decisions

### Request checks and output validation live in the SDK
`@friday/sdk` gets `llm.ts`:
- the request and result types
- `LlmError` with `kind`
- `checkRequest()`: exactly one of `prompt` or `messages`, and a schema that compiles
- `parseOutput(schema, text, finishReason)`: JSON parse, ajv validation, the truncation check

Core's provider and the test host both call these, so the test host's `invalid_output` is the real one. `ajv` becomes a direct `@friday/sdk` dependency, at the version already in the tree. Schemas are compiled once and cached per schema object (`WeakMap`), because a nightly job calls with the same schema repeatedly.

*Alternative:* accept zod schemas. Rejected. Tools already describe parameters as plain JSON-ish schemas, Gemini takes JSON Schema directly as `responseJsonSchema`, and modules don't have to pick a schema library.

### Provider: `GeminiTextModel` behind a small interface
`packages/core/src/llm/` holds:
- `TextModel`: `generate(req, { signal }) → { text, finishReason, blockReason?, model, usage }`
- `GeminiTextModel`, implementing it with `new GoogleGenAI({ apiKey }).models.generateContent`
- `LlmService`, which wraps any `TextModel` with the queue, retries, timeout, logging and validation, and hands out per-owner `ModuleLlm` facades

The mapping to Gemini:
- `system` → `config.systemInstruction`
- `prompt` → a single user content; `messages` → `contents` with `role: "user" | "model"`
- `schema` → `responseMimeType: "application/json"` plus `responseJsonSchema`
- the signal → `config.abortSignal`

Thinking settings are left at the model default.

Tests inject a fake `TextModel` into `LlmService`, so queueing, retries and error mapping are tested without network access. One opt-in live test (skipped unless `GEMINI_API_KEY` and `FRIDAY_LIVE_TESTS=1` are set) checks the real mapping.

### Error mapping

| Provider outcome | Kind | Retried |
|---|---|---|
| network error, `ApiError` 429 / 500 / 502 / 503 / 504 | `unavailable` | yes, 2x |
| timeout (our timer) | `unavailable` | no |
| missing key | `unavailable` | no |
| `ApiError` 400 / 404 (bad model name, bad schema accepted by ajv but rejected by Gemini) | `invalid_request` | no |
| `promptFeedback.blockReason`, `finishReason` SAFETY / RECITATION / PROHIBITED_CONTENT / BLOCKLIST / SPII / OTHER | `blocked` (reason carried) | no |
| `finishReason` MAX_TOKENS with a schema | `invalid_output` (truncated) | no |
| parse or validation failure | `invalid_output` (raw text carried, capped at 2000 characters) | no |
| signal aborted | `cancelled` | no |

Retry delays are 1 s and then 4 s, each with ±20% jitter, and each delay is itself aborted by the signal. Output validation failures aren't retried automatically. The caller decides, because re-asking with the same prompt tends to give the same bad answer, and a job may prefer to skip the item.

### Timeout wraps the signal
Each attempt gets `AbortSignal.any([callerSignal, AbortSignal.timeout(ms)])`. When the timeout fires, the rejection is mapped to `unavailable` ("timed out after N ms"). When the caller's signal fired, it's `cancelled`. The timeout covers each attempt, not the queue wait, so a busy queue doesn't turn into spurious timeouts.

### Concurrency: a FIFO semaphore in `LlmService`
A simple counter-and-queue semaphore, sized by `FRIDAY_LLM_CONCURRENCY`. An aborted waiter is removed from the queue and rejects with `cancelled`. One queue across all modules: the budget is the account's rate limit, which is shared.

### Models and tiers
`settings.textModel = FRIDAY_TEXT_MODEL ?? "gemini-flash-latest"` and `settings.textModelFast = FRIDAY_TEXT_MODEL_FAST ?? settings.textModel`. The default is an alias that follows Google's current Flash model, so it doesn't go stale the way the pinned Live model name does. The alias is checked against `models.list` during implementation (task 2.1), and replaced by a pinned name if the alias isn't served.

### Logging
`LlmService` logs one line per settled call through core's logger:
`llm: [brain] gemini-flash-latest ok in=1834 out=212 think=640 2.4s (1 attempt)`.
Content is never logged, because prompts will contain transcripts.

### Context and hosts
`ModuleContext.llm: ModuleLlm`. `ModuleHost` gets `llm?: (id) => ModuleLlm`. `createContext` defaults to a facade that rejects with `LlmError("unavailable", "text generation is not available in this host")`, which covers the remote runner. The test host builds a facade over a `TextModel` adapter around the user's fake function. It applies `checkRequest` and `parseOutput`, skips the queue, retries and timeout, and records requests in `host.llmRequests`.

## Risks / Trade-offs

- [The `gemini-flash-latest` alias changes behaviour under us] → That's the point for a default. A deployment that needs stability pins `FRIDAY_TEXT_MODEL`, and the log line names the model on every call.
- [Background calls cost money unattended] → The concurrency bound, per-call logs with token counts, and jobs that are visible in the portal. Quotas are deferred until there's a real cost signal.
- [Gemini's schema support is a subset of JSON Schema] → A schema can pass ajv and still be rejected by Gemini, which surfaces as `invalid_request` with Gemini's message. The SDK README lists the supported keywords.
- [ajv in the SDK grows remote module bundles] → It's already a transitive dependency through the MCP SDK, so nothing changes in practice.

## Migration Plan

No schema or data changes. New env vars (`FRIDAY_TEXT_MODEL`, `FRIDAY_TEXT_MODEL_FAST`, `FRIDAY_LLM_CONCURRENCY`, `FRIDAY_LLM_TIMEOUT_MS`) have defaults and are documented in `.env.example`. Rollback means deploying the previous image. Nothing uses `ctx.llm` until the brain change lands.
