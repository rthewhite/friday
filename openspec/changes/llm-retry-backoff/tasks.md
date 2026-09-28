# Tasks

## 1. Request and settings

- [x] 1.1 Add optional `maxRetryWaitMs` to `LlmRequest` in `packages/sdk/src/llm.ts`, rejected by `checkRequest` as `invalid_request` when negative or non-finite. Verify with cases in `packages/sdk/test/llm.test.ts`
- [x] 1.2 Add `llmMaxRetryWaitMs` (`FRIDAY_LLM_MAX_RETRY_WAIT_MS`, default 60000) to `llmSettings` and `.env.example`, pass it to `LlmService` in `server.ts`, and verify the default with the existing settings test

## 2. Retry handling

- [x] 2.1 Extend `classify()` to parse a 429 `ApiError.message` for `RetryInfo.retryDelay` and the `QuotaFailure` quota id (daily when it contains `PerDay`), falling back silently on parse failure. Verify with unit tests over a captured Gemini 429 body, a per-day body, a body without details, and a non-JSON message
- [x] 2.2 Use it in the retry loop: wait the stated delay plus 0–10% jitter (never shorter), reject at once when the wait exceeds the bound or the quota is daily, fall back to `retryDelaysMs` otherwise, keep the concurrency slot during waits, and end waits on abort with `cancelled`. Verify with `packages/core/test/llm.test.ts` cases using a fake `TextModel` and an injectable sleep/clock: a 37 s wait then success, a 90 s wait over a 60 s bound, a daily quota, a per-request `maxRetryWaitMs`, and abort during a wait
- [x] 2.3 Record retry reasons in the log line (`(3 attempts: 429 wait 37s, 503 wait 4.1s)`, `network` for unreachable). Verify the log-line tests for a clean call, a retried call and a failed call, and that no prompt text appears

## 3. Docs and integration

- [x] 3.1 Document the rate-limit behaviour and `maxRetryWaitMs` in `packages/sdk/README.md` (error table and request fields) and `FRIDAY_LLM_MAX_RETRY_WAIT_MS` in the README table, and verify both match `.env.example`
- [ ] 3.2 Run `pnpm test` and `pnpm -r typecheck` across the workspace, and verify both pass
- [ ] 3.3 Deploy and verify with a one-off script in the pod (as for module-llm 4.2) that a rate-limited call's log line lists the 429 and its wait, and that the call succeeds when the wait is within the bound
