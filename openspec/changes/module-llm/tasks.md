# Tasks

## 1. SDK contract

- [x] 1.1 Add `ajv` (the version already in the lockfile) as a direct `@friday/sdk` dependency, and verify `pnpm install` and `pnpm -r typecheck` succeed
- [x] 1.2 Add `packages/sdk/src/llm.ts` with the request and result types, `LlmError` (`kind`, `reason?`, `raw?`), `checkRequest()` (one of `prompt`/`messages`, the schema compiles), and `parseOutput()` (JSON parse, ajv validation with a per-schema compile cache, the MAX_TOKENS truncation check), and export them. Verify with `packages/sdk/test/llm.test.ts` covering both/neither input, an invalid schema, conforming output, an empty array, non-conforming output with the raw text carried, and truncation
- [x] 1.3 Add `llm` to `ModuleContext` and `createContext` (default rejects with `unavailable`, "text generation is not available in this host"), and verify a remote-runner test for that rejection
- [x] 1.4 Add the `llm` option to `createTestHost` (a fake function returning raw text or throwing `LlmError`, run through `checkRequest`/`parseOutput`, requests recorded in `host.llmRequests`, and `unavailable` without the option). Verify with test-host tests for a validated fake answer, a non-conforming fake answer giving `invalid_output`, recorded requests, and no fake
- [x] 1.5 Document `ctx.llm` in `packages/sdk/README.md` (request shape, error kinds and when to retry, Gemini's supported schema keywords, testing with a fake), and verify the example compiles by using it in `llm.test.ts`

## 2. Core provider and service

- [x] 2.1 Confirm with `models.list` (using the homelab key) that `gemini-flash-latest` is served for `generateContent`, or choose a pinned Flash model, and record the choice in `design.md`. Add `textModel`, `textModelFast`, `llmConcurrency` and `llmTimeoutMs` to core `settings`, and document `FRIDAY_TEXT_MODEL`, `FRIDAY_TEXT_MODEL_FAST`, `FRIDAY_LLM_CONCURRENCY` and `FRIDAY_LLM_TIMEOUT_MS` in `.env.example`. Verify the defaults and the fast-tier fallback with a unit test
- [x] 2.2 Implement `TextModel` and `GeminiTextModel` in `packages/core/src/llm/gemini.ts` (system, prompt/messages, schema to `responseJsonSchema`, abort signal, usage including thought tokens, finish and block reasons). Verify with unit tests over a stubbed `GoogleGenAI` that the generated config matches, and with an opt-in live test gated by `FRIDAY_LIVE_TESTS=1`
- [x] 2.3 Implement `LlmService` in `packages/core/src/llm/service.ts`: the FIFO semaphore, per-attempt timeout via `AbortSignal.any`, the error mapping table, 2 retries for transient errors with jittered 1 s / 4 s delays that respect the signal, validation through the SDK helpers, and one content-free log line per call. Verify with `packages/core/test/llm.test.ts` using a fake `TextModel`: 503-then-ok resolves, persistent 503 gives `unavailable` after 3 attempts, block gives `blocked` without retry, timeout gives `unavailable`, abort while queued and in flight gives `cancelled`, 5 concurrent calls run 2 at a time in order, a missing key gives `unavailable`, and the log line has no prompt text

## 3. Wiring

- [x] 3.1 Pass `llm: (id) => service.forOwner(id)` from `ModuleHost` into `createContext`, and create the service in `server.ts` with `GeminiTextModel`. Verify a `module-host.test.ts` case that a module's call is attributed to its id in the log
- [x] 3.2 Add a README section on text generation for modules (what it's for, the env vars, cost visibility through logs), and verify it matches `.env.example`

## 4. Integration

- [ ] 4.1 Run `pnpm test` and `pnpm -r typecheck` across the workspace, and verify both pass
- [ ] 4.2 Deploy to the homelab and verify with a temporary verification job (removed afterwards) that calls `ctx.llm.generate` with a schema: the run is `ok` on the Jobs page, and the core log shows one `llm:` line with the model and token counts and no content
