# Tasks

## 1. Refresh without a module

- [x] 1.1 In `packages/core/src/oauth/tokens.ts`, add `OAuthTokens.refreshNow(provider)` returning `refreshed`, `skipped` (not `connected`, no refresh token, provider can't refresh), `error` (refused or undecryptable, state now `error`), `retry` (transient, state unchanged) or `changed` (saved with another client or deleted meanwhile). It computes scopes like `token()` and shares the `inflight` refresh with it. `token()` keeps its behaviour and uses the same shared refresh. Verify with new tests in `packages/core/test/oauth-tokens.test.ts` on the fake client and clock: each outcome, a connection with no grants is still refreshed, a `token()` call and a `refreshNow` at the same time make one refresh request, a provider without refresh is `skipped` and stays `connected`, and the existing token tests still pass

## 2. Keep-alive job

- [ ] 2.1 Add `packages/core/src/oauth/keepalive.ts` with `keepaliveJob(tokens, store)` (name `oauth-keepalive`, cron `0 5 * * *`, `timeoutMs` 5 minutes, sequential, stops between connections on abort) and `registerOAuthKeepalive(jobs, tokens, store)`. The summary counts refreshed connections and names the providers needing a reconnect (with the reason) and those retried. The run throws with the summary when a connection went to `error`, and has a "nothing refreshed: FRIDAY_MASTER_KEY is not set" summary without a master key. Verify with a new `packages/core/test/oauth-keepalive.test.ts`: every scenario of "Logins are kept alive" except "Run now", an aborted signal stopping before the next connection, and no token or client secret in a summary, error or log line
- [ ] 2.2 Register the job in `packages/core/src/server.ts` after `registerRetention`. Verify with a scheduler test in `oauth-keepalive.test.ts`: the job registers as `core/oauth-keepalive` with its cron, and a manual run (trigger `manual`) refreshes and leaves `nextRunAt` at 05:00. Also verify `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck` pass
- [ ] 2.3 Docs: in the README's OAuth connections section, say that logins are refreshed nightly at 05:00 and what stays out (Google Testing mode, providers without refresh). Add the job to the Background jobs section next to retention. Update the OAuth part of `openspec/config.yaml`'s context (keepalive job, `refreshNow`). Verify by reading both back against the spec

## 3. End to end

- [ ] 3.1 Locally, with Spotify connected: `Run now` on `core/oauth-keepalive` from the Jobs page gives an `ok` run with "refreshed 1", and the connection's `expiresAt` moves. Revoke Friday at Spotify, run it again: the run is `failed` naming Spotify, and the Connections page shows `error` with `Reconnect`. Needs the user to revoke and reconnect
- [ ] 3.2 After deploy, check the first scheduled run at 05:00 on the Jobs page at `https://friday.thewhite.nl`. Needs the user
