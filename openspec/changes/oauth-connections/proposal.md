# Proposal

## Why

Friday can only talk to services that accept a fixed key or password (Jellyfin, Home Assistant, TomTom, iCloud). Services like Spotify, Google and GitHub need an OAuth login in a browser and tokens that expire and must be refreshed. Jarvis solved this with OAuth connections in its config service. Friday needs the same, plus something Jarvis lacks: a module gets a provider's token only after the user grants that module access. The first consumer is a port of Jarvis's Spotify module.

## What Changes

- **OAuth connections**, one per provider, stored in `friday.db`: provider, client id and secret, scopes, tokens and state (`disconnected`, `connected`, `error`). The client secret and tokens are encrypted with `FRIDAY_MASTER_KEY` like configuration secrets.
- **Provider catalogue**: every Arctic provider with a standard constructor, as in Jarvis, plus `generic` (any OAuth2 provider, with its authorization and token URLs). Adding a provider that Arctic supports, or a standard OAuth2 provider, needs no change to Friday's OAuth code.
- **Authorization flow** in core: `GET /api/oauth/:provider/authorize` redirects to the provider with a `state` value and, when the provider uses it, PKCE. `GET /api/oauth/:provider/callback` exchanges the code, stores the tokens and returns to the portal. The redirect URI is built from a new optional core key `FRIDAY_PUBLIC_URL`, and from the request's origin when it is unset.
- **Module requests and grants**: a manifest may declare `oauth` requests (`provider`, `scopes`, `description`, and for `generic` the `authUrl` and `tokenUrl`). The user grants or revokes each requesting module per connection. `ctx.oauth.token(provider)` returns a fresh access token, refreshing it when it is about to expire, and rejects with an SDK `OAuthError` (`not_connected`, `not_granted`, `refresh_failed`) otherwise. A request never stops a module from loading, and granting or connecting needs no reload.
- **Scopes follow the grants**: the scopes Friday asks the provider for are the union of the scopes requested by the granted modules plus any extras the user adds. When that set holds scopes the stored token does not have, the connection shows which module needs which scope and offers `Reconnect`.
- **Portal**: `System > Connections` (`/settings/connections`) lists connections and the requests that have no connection yet. A drawer handles provider, client credentials, the redirect URI to register, connect and reconnect, extra scopes and per-module grants.
- **Spotify module** (`modules/spotify`, id `spotify`): a port of Jarvis's Spotify tool with `search_spotify` (tracks, artists and albums with their URIs) and `list_spotify_playlists`, using `ctx.oauth.token("spotify")`.
- **Test host**: `createTestHost` accepts fake tokens and errors per provider, so modules can be tested without a provider.

Out of scope, each for a later change: OAuth for remote modules (they bring their own credentials) and the remote host rejects `ctx.oauth`; MCP server headers filled from a connection's token; more than one account per provider; Sonos playback (Jarvis's `search-and-play-on-sonos`), which plays Spotify URIs and raises its own LAN discovery question.

## Capabilities

### New Capabilities

- `oauth-connections`: connections and their encrypted storage, the provider catalogue, the authorization flow and redirect URI, token refresh, module requests and grants, scopes derived from grants, the `/api/oauth` API and the portal's Connections page.
- `spotify`: the Spotify module and its two tools.

### Modified Capabilities

- `module-system`: the manifest gains `oauth` requests, `ModuleContext` gains `oauth`, the test host fakes it, and hosts without connections (the remote runner) reject it.
- `secret-management`: core declares `FRIDAY_PUBLIC_URL` among its own keys.
- `portal-shell`: the sidebar's `System` section gains `Connections`.

## Impact

- New `packages/core/src/oauth/` (store, catalogue, flow, token service with refresh, routes) and migration 10 (`oauth_connections`, `oauth_grants`). Migration 9 is claimed by `agents`. If `oauth-connections` merges first, it takes 9 and `agents` renumbers.
- New dependency `arctic` in `@friday/core`.
- `packages/sdk/src/module.ts`, `context.ts`, `test.ts`, `index.ts`: `ModuleManifest.oauth`, `ModuleContext.oauth`, `OAuthError`, manifest validation, the test host option. `packages/sdk/src/remote/`: `ctx.oauth` rejects.
- `packages/core/src/module-host.ts`, `app.ts`, `core-config.ts`: wiring, `/api/oauth` routes, `FRIDAY_PUBLIC_URL`.
- Portal: `ConnectionsPage.vue` under `pages/settings/`, the router and the sidebar entry. `ConfigurationPage.vue` is not touched, so this does not conflict with `agents`' MCP servers tab. Both changes add a sidebar entry, so the second to merge has a one-line rebase in the sidebar.
- New `modules/spotify` package and its entry in `packages/core/src/modules.ts`.
- Docs: README (Connections, Spotify), `.env.example` (`FRIDAY_PUBLIC_URL`), `openspec/config.yaml` context.
