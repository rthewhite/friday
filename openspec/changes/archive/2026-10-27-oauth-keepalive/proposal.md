# Proposal

## Why

Friday refreshes an OAuth access token only when a module asks for one. Some providers drop refresh tokens that go unused: Google after six months, and Microsoft after an inactivity window that can be much shorter. A connection that Friday rarely uses can therefore die quietly, and the user finds out only when a question fails with "needs to be reconnected". Spotify is fine today, but the Google and Microsoft connections planned next (mail intake in `document-store`, for one) are not.

## What Changes

- A nightly core job, `core/oauth-keepalive`, refreshes every `connected` connection that has a refresh token and whose provider can refresh, whether or not a module used it that day.
- The job uses the same refresh path as `ctx.oauth.token`. It shares a refresh that is already in flight, and it keeps the same rules: a refusal by the provider puts the connection in `error` with the provider's message, a network failure or provider server error leaves it `connected`, and a refresh that finishes after the connection was changed is discarded.
- The run's summary counts what was refreshed, what needs a reconnect and what will be retried. The run is `failed` when a connection went to `error` during it, so the Jobs page shows it.
- The job also runs on demand from the Jobs page (`Run now`), so a connection can be checked right after setting it up.
- Visibility stays where it is: the Connections page (state and error) and the Jobs page. No badge, push or spoken notice.

Out of scope:
- Google's 7-day limit for apps in "Testing" mode. Refreshing doesn't extend it; the app has to be published.
- Providers that cannot refresh, or connections without a refresh token. They keep today's behaviour and go to `error` when their token expires and a module asks for it.
- Telling the user actively when a connection breaks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `oauth-connections`: a new requirement that core keeps logins alive with a nightly refresh job.

## Impact

- `packages/core/src/oauth/tokens.ts`: a refresh that isn't on behalf of a module, sharing the in-flight refresh with `token()`.
- New `packages/core/src/oauth/keepalive.ts` (the job), registered as a `core` job in `packages/core/src/server.ts`, next to `core/conversation-retention`.
- Tests in `packages/core/test/` (`oauth-keepalive.test.ts`, and `oauth-tokens.test.ts` for the shared refresh).
- No migration, no new configuration keys, no API or portal change. A connection's `updatedAt` and `expiresAt` now move every night.
- Docs: README (OAuth connections, Background jobs) and the OAuth part of `openspec/config.yaml`'s context.
- In flight: `sonos-speakers` and `document-store` don't touch `packages/core/src/oauth/`. `server.ts` is a common file, but this adds one line.
