# Design

## Context

`LlmService` (`packages/core/src/llm/service.ts`) classifies provider failures in `classify()` using `ApiError.status`, and retries statuses in `TRANSIENT_STATUS` (408, 429, 5xx) and network errors after `retryDelaysMs` (default `[1000, 4000]`, ±20% jitter). The per-attempt timeout doesn't cover the waits. `@google/genai` 2.24 builds `ApiError.message` as `JSON.stringify(errorBody)` for non-streaming calls. For a 429, Gemini's body carries `error.details[]` with a `google.rpc.RetryInfo` (`retryDelay: "37s"`) and a `google.rpc.QuotaFailure` whose violations name the quota (`quotaId`, e.g. `GenerateRequestsPerMinutePerProjectPerModel-FreeTier` or `...PerDay...`). See `proposal.md` for motivation.

## Goals / Non-Goals

**Goals:** Survive per-minute rate limits within one call, fail fast when waiting can't help, and make retries visible in the log.

**Non-Goals:** Rate limiting across calls (a shared token bucket), persisting quota state, or retrying more than 3 attempts.

## Decisions

### Parse the 429 body defensively in `classify()`
`classify()` returns `{ error, retry, reason, waitMs?, quota? }`. For status 429, it tries `JSON.parse(e.message)` and reads `error.details`:
- the first `@type` ending in `RetryInfo` gives `retryDelay`, parsed from protobuf-duration form `"<n>[.<frac>]s"` into ms
- the first `QuotaFailure` violation gives `quotaId`, falling back to `quotaMetric`

Any parse failure leaves both undefined, and the call falls back to today's behaviour. A quota id or metric containing `PerDay` (case-insensitive) counts as daily. No new dependency, and no reliance on SDK internals beyond the documented `message`.

*Alternative:* read the HTTP `Retry-After` header. Rejected, because the SDK doesn't expose response headers on `ApiError`, and Gemini reports the delay in the body.

### Wait selection
For attempt *n* failing with a retryable error:
- Daily quota: no retry, `unavailable: rate limited: daily quota <id> exhausted`.
- `waitMs` known and `> bound`: no retry, `unavailable: rate limited: provider asks to wait <s>s (limit <bound>s)`.
- `waitMs` known: wait `waitMs` plus 0–10% jitter. It's never shortened, because retrying early would just burn the attempt.
- Otherwise: `retryDelaysMs[n-1]` with ±20% jitter, as now.

The bound is `req.maxRetryWaitMs ?? settings.llmMaxRetryWaitMs`. `checkRequest` rejects a negative or non-finite `maxRetryWaitMs` as `invalid_request`, so the test host enforces the same rule.

### The concurrency slot is held while waiting
A call keeps its semaphore slot during a retry wait. Releasing it would let queued calls hit the same limit immediately. Holding it gives natural backpressure: with the default concurrency of 2, at most two calls are ever waiting on Gemini.

### Log format
The attempt suffix becomes `(1 attempt)`, or `(3 attempts: 429 wait 37s, 503 wait 4.1s)`, listing each failed attempt that was followed by a retry or ended the call. Network errors show as `network`. The final error message already names the last failure. Nothing from the response body is logged except the quota id, which is not user content.

## Risks / Trade-offs

- [A call can now take about 2 minutes (two 60 s waits plus attempts)] → That's acceptable for background jobs, and interactive callers pass a small `maxRetryWaitMs`. The job's own `timeoutMs` and abort signal still bound it.
- [Gemini changes its error body shape] → Parsing is best-effort, so the worst case is today's 1 s / 4 s behaviour. Tests pin the known shape from a captured 429 body.
- [Holding slots during waits delays unrelated modules' calls] → At most `FRIDAY_LLM_CONCURRENCY` calls wait. Those calls would be rate-limited anyway, since the quota is per project.

## Migration Plan

No data changes. One new optional env var with a default. Rollback means redeploying the previous image.
