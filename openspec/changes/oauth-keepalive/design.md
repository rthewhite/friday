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

Add `OAuthTokens.refreshNow(provider)`. It reads the connection and its secrets and computes the scopes the same way `token()` does (`requests.requestedScopes(provider, store.grants(provider), conn.extraScopes)`). It then goes through the same `inflight` map and the same private `refresh()`. `token()` keeps its request, grant and state checks, and calls the shared piece when the token expires soon.

`refreshNow` returns an outcome instead of an access token:

```
refreshNow(provider) --> { result: "refreshed" }
                     |   { result: "skipped", reason }      not connected, no refresh token, can't refresh
                     |   { result: "error", message }       refused or undecryptable: state is now error
                     |   { result: "retry", message }       network or 5xx: state unchanged
                     |   { result: "changed" }              saved with another client or deleted meanwhile
```

It maps the `OAuthError`s that `refresh()` throws by looking at the connection's state afterwards. If the state is `error`, the outcome is `error`; otherwise it's `retry`. That way the error rules aren't copied.

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
      outcome = await tokens.refreshNow(conn.provider)
  summary = "refreshed 2; needs reconnect: microsoft (refreshing the login was refused: invalid_grant: ...); retry: none"
  any "error" outcome --> throw new Error(summary)   (run recorded as failed, message = summary)
  else                --> return { summary }
```

`registerOAuthKeepalive(jobs, tokens, store)` registers it as a `core` job in `server.ts`, right after `registerRetention`. It is always registered, also without a master key, so the Jobs page shows why nothing happens.

### `failed` only for a new `error`

A run is `failed` only when a connection went to `error` during that run. A connection that was already in `error` is skipped, and doesn't keep every later run red. The Connections page keeps showing the error until the user reconnects. Alternative: fail while any connection is in `error`. That keeps the Jobs page red until a fix, but a connection you leave broken on purpose would make it red forever.

## Risks / Trade-offs

- [The "updated" column on the Connections page now moves every night, so it no longer means "last changed by the user"] → Acceptable. It shows the login is alive, and `expiresAt` already moved on every refresh.
- [Refresh-token rotation: if a provider rotates the token and storing the new one fails, the old one may already be invalid] → The same risk `token()` has today. `storeTokens` is one statement. Refreshing once a day instead of only when used doesn't change the odds much.
- [A refresh request that hangs: Arctic's fetch takes no abort signal] → `timeoutMs` marks the run `failed`. The next run is skipped until the request settles, which is bounded by the fetch's own timeouts. A hung refresh would block `token()` for that provider the same way it does today.
- [Refreshing more often than needed could trip a provider's rate limit] → One request per connection per day is far below any provider's limit.

## Migration Plan

Additive. After deploy, the job appears on the Jobs page and first runs at the next 05:00. A brand-new job isn't caught up. `Run now` checks it right away. Rollback: revert the commit. Nothing is stored except the usual job run records.
