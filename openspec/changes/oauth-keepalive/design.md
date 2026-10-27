# Design

## Context

See proposal.md for the motivation and `specs/oauth-connections/spec.md` for the behaviour.

- `OAuthTokens.token(provider, moduleId)` (`packages/core/src/oauth/tokens.ts`) checks the request, grant, state and master key, refreshes when the token expires within 60 s, and keeps one in-flight refresh per provider in `inflight`. The private `refresh()` holds the error rules: refusal → `setError`, transient → warn and leave `connected`, changed while refreshing → discard.
- Core already owns one job, `core/conversation-retention` (`packages/core/src/conversations/retention.ts`, cron `0 4 * * *`), registered in `packages/core/src/server.ts` with `jobs.register("core", spec)`. A handler returns `{ summary }` for `ok` and throws for `failed`.
- `server.ts` builds `oauthStore`, `oauthRequests` and `oauthTokens` before the module host. The scheduler is built earlier.

## Goals / Non-Goals

**Goals:**
- One refresh path. The job and `ctx.oauth.token` can't drift apart in how they refresh or handle errors.
- No new state: no migration, no new configuration key.

**Non-Goals:**
- Skipping connections that were refreshed recently. Every night, every eligible connection gets refreshed.
- A configurable schedule. If 05:00 turns out wrong, change the constant.

## Decisions

### Split a module-free refresh out of `token()`

Add `OAuthTokens.refreshNow(provider)`. It reads the connection and its secrets, builds the client once, and then goes through the same `inflight` map and the same private `refresh()` (which takes the client and the scopes as thunks, so a caller that joins an in-flight refresh builds nothing). `token()` keeps its request, grant and state checks, and calls the shared piece when the token expires soon.

**Scopes.** `token()` asks for the granted modules' scopes plus the extras (`requests.requestedScopes(...)`), as before. `refreshNow` asks for the scopes the provider reported granting the stored token (`conn.grantedScopes`), and only falls back to the module scopes when the provider reported none. For providers that refresh with scopes (DonationAlerts, start.gg), asking for the module scopes would narrow the token of a connection whose grants were revoked or whose module is disabled, and the nightly job would do that silently. Keeping a login alive shouldn't change what it can do.

`refreshNow` returns an outcome instead of an access token:

```
refreshNow(provider) --> { result: "refreshed" }
                     |   { result: "skipped", reason }      not connected, no refresh token, can't refresh
                     |   { result: "error", message }       refused or undecryptable: state is now error
                     |   { result: "retry", message }       network, 5xx or anything unexpected: state unchanged
                     |   { result: "changed" }              saved with another client or deleted meanwhile
```

It maps what `refresh()` throws by the error itself, not by re-reading the state, which another caller may have changed meanwhile: an `OAuthError` whose cause is the provider's `OAuth2RequestError` is `error`, `not_connected` is `changed`, and the rest is `retry`. Errors that aren't `OAuthError`s (a token response without an access token, a client that can't be built, a database error) are `retry` too, so one bad connection never ends the run for the others. `refreshNow` never throws.

Alternatives:
- Calling `token(provider, someModule)` from the job: it needs a granted module, and it would skip connections that no module has a grant for. Those are exactly the connections that are going unused.
- A second refresh implementation in the job: it would drift from `token()`, and it couldn't share `inflight`.

**Skipping without an error.** If a connection can't refresh, or has no refresh token, `refreshNow` skips it. Today `refresh()` sets `error` on such a connection, but only once its token has expired and a module asks for it. The job leaves that behaviour as it is and doesn't put such connections in `error` early.

### The job is a thin loop in `oauth/keepalive.ts`

`keepaliveJob(tokens, store)` returns a `JobSpec` with name `oauth-keepalive`, cron `0 5 * * *` and `timeoutMs` 5 minutes. This follows `retention.ts`. 05:00 comes after the brain's 03:00 pass and retention at 04:00, so the nightly jobs don't run at the same time.

```
run({ signal })
  if !store.secretsEnabled --> return { summary: "nothing refreshed: FRIDAY_MASTER_KEY is not set" }
  for conn of store.list() (connected only), stop when signal.aborted:
      outcome = await within(tokens.refreshNow(conn.provider), 30 s)    (late --> retry, the refresh carries on)
  summary = "refreshed 2; skipped: AniList (does not refresh logins); needs reconnect: Microsoft (refreshing the
             login was refused: invalid_grant: ...); retry next run: GitHub (HTTP 503); still needs reconnect: Dropbox"
  any "error" outcome --> throw new Error(summary)   (run recorded as failed, message = summary)
  else                --> return { summary }
```

The 30-second limit per provider exists because Arctic's fetch takes no abort signal. Without it, one token endpoint that accepts the connection and never answers would use up the whole run, and since `store.list()` is ordered by provider, it would starve the same later providers every night until their refresh tokens went idle. Refusals and retries are also written to the job's log, prefixed with the provider.

`registerOAuthKeepalive(jobs, tokens, store)` registers it as a `core` job in `server.ts`, right after `registerRetention`. It is always registered, also without a master key, so the Jobs page shows why nothing happens.

### `failed` only for a new `error`

A run is `failed` only when a connection went to `error` during that run. A connection that was already in `error` is skipped, and doesn't keep every later run red, but every later summary ends with `still needs reconnect: <provider>` until it's reconnected, so the Jobs page keeps naming it. The Connections page keeps showing the error too. Alternative: fail while any connection is in `error`. That keeps the Jobs page red until a fix, but a connection you leave broken on purpose would make it red forever.

## Risks / Trade-offs

- [The "updated" column on the Connections page now moves every night, so it no longer means "last changed by the user"] → Acceptable. It shows the login is alive, and `expiresAt` already moved on every refresh.
- [Refresh-token rotation: if a provider rotates the token and storing the new one fails, the old one may already be invalid] → The same risk `token()` has today. `storeTokens` is one statement. Refreshing once a day instead of only when used doesn't change the odds much.
- [A refresh request that hangs: Arctic's fetch takes no abort signal] → The run gives up on that provider after 30 seconds and moves on; the request itself carries on until the fetch's own timeouts end it. Meanwhile a `token()` call for that provider joins the hanging refresh, the same as today. `timeoutMs` (5 minutes) is the backstop for the run as a whole.
- [Refreshing more often than needed could trip a provider's rate limit] → One request per connection per day is far below any provider's limit.

## Migration Plan

Additive. After deploy, the job appears on the Jobs page and first runs at the next 05:00. A brand-new job isn't caught up. `Run now` checks it right away. Rollback: revert the commit. Nothing is stored except the usual job run records.
