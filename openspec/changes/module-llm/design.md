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

**Confirmed (2026-09-28):** `models.list` lists `models/gemini-flash-latest` ("Gemini Flash Latest") with `generateContent` among its supported actions, so the default stays `gemini-flash-latest`. The opt-in live test got its answer from `gemini-3.8-flash` (the response's `modelVersion`). Pinned alternatives served at the time: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.5-flash`, and `gemini-flash-lite-latest` / `gemini-3.5-flash-lite` for a cheaper fast tier.

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

## Implementation notes

- **`result.model` is the configured name, the log shows both.** The result names the model core asked for (`FRIDAY_TEXT_MODEL` or the fast one), as the tier scenario requires. `TextResponse.model` carries the provider's `modelVersion`, and the log line appends it when it differs: `llm: [brain] gemini-flash-latest (gemini-3.8-flash) ok ...`.
- **Statuses outside the table.** 408 is retried like 429/5xx (the genai SDK treats it as transient too). Other HTTP errors (401, 403, ...) are `unavailable` without retry. `FinishReason` `IMAGE_SAFETY` and `IMAGE_PROHIBITED_CONTENT` count as `blocked` alongside the listed reasons.
- **ajv runs with `strict: false` and `validateFormats: false`.** Gemini-specific keywords such as `propertyOrdering` must not make a schema `invalid_request`, and `format` values are passed to Gemini but not checked locally (no `ajv-formats`). A schema that fails ajv's meta-schema check is still `invalid_request`.
- **Usage carries thought tokens.** `LlmUsage` has an optional `thoughtTokens` next to `inputTokens` / `outputTokens`; core always fills it.
- **Settings are a function of the environment.** `llmSettings(env)` in `config.ts` computes the four values and is spread into `settings`, so defaults and the fast-tier fallback are unit-tested without re-importing the module. An invalid or non-positive `FRIDAY_LLM_CONCURRENCY` falls back to 2.
- **Error log lines include the error message** (capped at 200 characters), which is ours or the provider's status text. The raw output of `invalid_output` is never logged.
- **Test host details.** The fake answers under model name `fake-standard` / `fake-fast` with zero usage. `host.llmRequests` records the requests that passed `checkRequest` and reached the fake. Non-`LlmError` throws from the fake become `unavailable`, and an aborted signal gives `cancelled`, so every rejection carries a kind.
- **Model check (task 2.1)** used the key in the repository's local `.env`, read-only, not the homelab key. The key was on a tight per-minute quota at the time: the live test succeeded after one or two 429 retries, which also exercised the retry path against the real API. Per-minute quota exhaustion can outlast the 1 s / 4 s retries and then surfaces as `unavailable`.
