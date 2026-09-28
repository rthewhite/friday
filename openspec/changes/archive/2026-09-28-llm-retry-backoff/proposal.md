# Proposal

## Why

On the Gemini free tier, `ctx.llm` calls hit per-minute rate limits (HTTP 429) regularly. A 15-token call in production needed 3 attempts and 22 s. Core retries after fixed 1 s and 4 s delays, so all attempts can land inside the same blocked minute, and the call then fails with `unavailable`. That would make a nightly brain pass fail quietly. Gemini's 429 responses say how long to wait and which quota was hit, but core ignores both, and its log line only counts attempts, so it's impossible to see why a call was slow or failed.

## What Changes

- After a 429, the next attempt waits for the delay Gemini asks for, up to a maximum wait: `FRIDAY_LLM_MAX_RETRY_WAIT_MS` (default 60000), overridable per request with `maxRetryWaitMs`. Without a provider delay, the existing 1 s / 4 s backoff applies.
- A rate limit whose requested wait exceeds the maximum, or whose quota is per day, is not retried. It rejects with `unavailable` at once, with a message naming the wait or the quota, instead of burning attempts that can't succeed.
- The number of attempts stays at 3, and waits still end on abort.
- The per-call log line records why each retry happened, e.g. `(3 attempts: 429 wait 37s, 503)`.

Out of scope: raising the free-tier limits (a billing decision), cross-call rate limiting or token budgeting, and changing the concurrency limit.

## Capabilities

### New Capabilities

### Modified Capabilities
- `module-llm`: retry behaviour for rate limits ("Failures are typed"), and the per-call log line listing retry reasons ("Usage is logged without content").

## Impact

- `packages/core/src/llm/service.ts`: error classification reads the retry delay and quota from Gemini's 429 body, the retry loop uses it, and the log line lists reasons.
- `packages/sdk/src/llm.ts`: optional `maxRetryWaitMs` on the request type.
- Config: `FRIDAY_LLM_MAX_RETRY_WAIT_MS` in core settings and `.env.example`. README and SDK README notes.
- Behaviour: a rate-limited call can now take up to about 2 minutes plus the per-attempt time, instead of failing within about 5 seconds.
