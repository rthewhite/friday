# Design

## Context

Jarvis (`~/Projects/jarvis`) has OAuth connections in its config service:
- `packages/config/src/oauth/providers.ts` is a table of about 50 Arctic 3.7 classes. Each entry has a class name, display name, `authPattern` (which `createAuthorizationURL` signature the class has), `hasRefresh` and `ctorParams`. The classes are reached as `(arctic as any)[className]`, with `arctic.OAuth2Client` as the generic fallback.
- `packages/config/src/db/oauth.ts` stores connections with AES-GCM fields and a `requestors` table.
- `packages/config/src/routes/oauth.ts` serves a `/:provider/token` endpoint that any caller can use. The caller names itself in `requestedBy`, which is only recorded.

Friday has the pieces this builds on:
- `packages/core/src/secrets/crypto.ts`: `encrypt`/`decrypt` with AAD `scope:key`. `mcp-store.ts` already reuses it for header secrets.
- `core-config.ts`: core's own declared keys, read per use.
- `module-host.ts`: builds each module's context through the SDK's `createContext`. Unset capabilities get facades that throw "not available in this host" (`packages/sdk/src/context.ts`), which is how the remote runner rejects `ctx.db` and `ctx.prompt`.
- Core routes go on the router in `app.ts`. The CSRF guard only affects non-GET `/api/` requests.
- Portal settings pages are routed in `packages/portal/src/router.ts`.
- The latest migration on `main` is 9 (`agents`, see decision 3).

## Goals / Non-Goals

**Goals:**
- A token never leaves core except through `ctx.oauth.token` to a granted in-process module. There is no token endpoint.
- Adding a provider from the catalogue, or a standard OAuth2 provider, needs no change to the OAuth code.
- An Arctic upgrade that breaks a catalogue provider fails CI, not the first time someone clicks Connect.
- Connecting, granting and revoking take effect without restarting or reloading a module.

**Non-Goals:**
- Enforcing scopes per module. There is one token per provider, so a granted module can use every scope that token carries (see Risks).
- Revoking tokens at the provider on delete. Deleting a connection forgets the tokens. The user removes the app's access at the provider if they want that.
- Surviving a restart in the middle of a login. A pending authorization lives in memory, and the user clicks Connect again.

## Decisions

### 1. OAuth lives in core, not in a module

New `packages/core/src/oauth/`:

```
catalogue.ts   provider table + generic, buildClient(connection, redirectUri)
store.ts       oauth_connections / oauth_grants, encryption of secret fields
flow.ts        pending authorizations (state -> provider, verifier, redirectUri, expiry)
tokens.ts      token(provider, moduleId): grant check, expiry check, single-flight refresh
requests.ts    requests from core's module list (manifests), union of scopes, missing scopes
routes.ts      /api/oauth/*
```

Grants need every module's manifest and the encrypted store, and modules may only depend on `@friday/sdk`. So this goes next to secrets, MCP and alerts in core, not into a module.

### 2. Catalogue: Jarvis's table, made checkable

Port Jarvis's `PROVIDER_REGISTRY` as is: the same ids, display names and `authPattern`/`hasRefresh`/`ctorParams`. Check it against Arctic's current exports when porting, so providers added to Arctic since 3.7 can come along. Arctic's classes handle non-standard providers (Basic auth for Reddit and Notion, TikTok's `client_key`, Withings' wrapped response), which a generic client cannot.

Changes from Jarvis:
- **Each entry records whether it uses PKCE**, derived from `authPattern`. The listing reports it, and the flow only stores a verifier when one is needed.
- **Every authorization URL carries Friday's `state`.** Two Arctic classes build URLs without one (Naver: no arguments; DonationAlerts: scopes only), so `buildClient` adds it when the class didn't. The callback check then holds for every provider.
- **Arguments Jarvis's table missed.** StartGG passes the scopes again when exchanging the code and refreshing, and DonationAlerts when refreshing (`validateWithScopes`, `refreshWithScopes`). Google gets `access_type=offline&prompt=consent` (`authParams`), because without it Google returns no refresh token.
- **Catalogue tests** in `oauth-catalogue.test.ts`. For every entry, the class must exist in Arctic's exports, and its constructor, `createAuthorizationURL`, `validateAuthorizationCode` and `refreshAccessToken` arities must match the entry. Every entry builds an authorization URL with `state`, and with `code_challenge` exactly when it uses PKCE. A third test fails when Arctic exports a provider that is neither in the catalogue nor on the excluded list (constructors that need a domain, tenant or key), so a new Arctic provider is noticed. A renamed class or a changed signature then fails `pnpm -r test`.

The reflection stays. It is the only way to cover the whole catalogue without one adapter per provider, and the test is what makes it safe.

**Generic** connections use `arctic.OAuth2Client` with the connection's URLs: `createAuthorizationURLWithPKCE` (S256), `validateAuthorizationCode(tokenUrl, code, verifier)` and `refreshAccessToken(tokenUrl, refreshToken, [])`. Jarvis's generic did not use PKCE. Friday always does, since servers that don't support it ignore the extra parameters.

*Alternative considered*: a few presets as data (URLs plus quirks) on top of `OAuth2Client`. Rejected because the user wants the full catalogue, so that a new feature's provider never touches this code.

### 3. Storage: migration 10

```
oauth_connections  provider PK, client_id, client_secret_* NULL, auth_url NULL, token_url NULL,
                   extra_scopes_json, access_token_* NULL, refresh_token_* NULL, expires_at NULL,
                   granted_scopes_json NULL, state, error NULL, created_at, updated_at
oauth_grants       provider -> oauth_connections ON DELETE CASCADE, module_id, granted_at,
                   PRIMARY KEY (provider, module_id)
```

`*_` columns are three BLOBs (ciphertext, iv, tag). They are encrypted with `crypto.ts` with AAD scope `oauth:<provider>` and the field name as the key, so a ciphertext copied to another row or field fails to decrypt. A grant for a module that is not in the module list stays in the table and applies again when the module comes back. `module_id` therefore has no foreign key.

The branch used 9, then the next free number on `main`. `agents` merged first with 9, so following the CLAUDE.md rule that a migration number is claimed at merge, this change took 10 at its rebase. A branch must never skip a number ahead of merge. The runner skips every migration at or below the stored version, so a deployed 10 would make a later 9 never run.

Changing a URL of a connection that has a stored client secret requires the secret again (400 otherwise). Without that, anyone who can reach the portal could point a generic token URL at their own server and receive the stored secret at the next code exchange.

### 4. Requests come from manifests and are never stored

`requests.ts` reads `manifest.oauth` from core's module list (after `FRIDAY_MODULES`, including failed modules, whose manifests are still known). The listing joins requests, connections and grants per provider. Everything is computed per call: the union of requested scopes, the missing scopes and their modules, and the generic URL defaults (from the first request in load order). Nothing goes stale when a module's manifest changes between deployments.

### 5. Authorization flow

`authorize`:
1. If the redirect base (decision 6) has another origin than the request, answer 302 to `<base>/api/oauth/<id>/authorize?moved=1` and stop. The cookie has to be set on the host the provider sends the browser back to. Otherwise a portal opened at the LAN IP, with `FRIDAY_PUBLIC_URL` set, could never complete a login. `moved=1` stops a redirect loop behind a proxy that hides the public host.
2. Load the connection and read only its client secret. Unreadable tokens (after a master key change) must not block the login that replaces them.
3. Compute the scopes from the grants plus the extras.
4. Build the redirect URI (decision 6).
5. Create a 32-byte random `state` and, when the provider uses PKCE, a verifier.
6. Keep `{ provider, clientId, verifier, redirectUri, expiresAt }` in an in-memory map for 10 minutes, with expired entries swept on access.
7. Set the cookie `friday_oauth_state=<state>; HttpOnly; SameSite=Lax; Path=/api/oauth; Max-Age=600`, plus `Secure` when the redirect URI is https.
8. Answer 302 to the provider.

`callback`:
1. Take `state` from the query and check it against the cookie and the map: same provider, not expired.
2. Delete the entry, so a state works once.
3. Clear the cookie.
4. Handle the provider's `error` parameter, if there is one.
5. Refuse it if the connection now has another client id than the login started with. Check this again after the exchange, since the user can save while the code is being exchanged.
6. Otherwise exchange the code with the stored redirect URI and verifier, then store the tokens, `accessTokenExpiresAt()`, and `scopes()` when the provider reports them (else the requested ones).
7. If the exchange fails, set `error` only on a connection without a working login. A failed Reconnect, for example to add a scope, leaves a connected connection as it was.
8. Answer 302 to `/settings/connections?provider=<id>&connected=1` or `&error=`.

Both endpoints are GET, so the CSRF guard doesn't apply. That matters, because the callback is a cross-site top-level navigation from the provider. The cookie is `Lax` so it is sent on that navigation, and the `state`/cookie pair is what stops forged callbacks (login CSRF). A third-party site linking to `authorize` can only start a login with Friday's own client, which the user still has to approve at the provider.

### 6. Redirect URI

`FRIDAY_PUBLIC_URL` (core key, read per use through `coreConfig`) gives the base, if it parses as an absolute http(s) URL. Any other value is ignored, with one warning per value, rather than producing redirect URIs no provider accepts. The listing returns the base as `redirectBase`, so the portal shows the right URI even for a connection it is only creating. Without a valid public URL, the base is the request's origin, using `X-Forwarded-Proto` and `X-Forwarded-Host` as Traefik sets them. The listing computes it from its own request, so what the portal shows is exactly what `authorize` sends when started from the same address. Headers can be spoofed, but that only affects the redirect URI in the user's own authorization request, and the provider refuses URIs that aren't registered.

Spotify only accepts `https` redirect URIs or a loopback IP, not `localhost`. The README tells local developers to open the portal at `http://127.0.0.1:<port>`.

### 7. Token service

`tokens.token(provider, moduleId)`:
1. Check the request and grant (`not_granted`) and the connection and master key (`not_connected`).
2. If the state is `error`, return `refresh_failed` with the stored error.
3. If the token expires more than 60 s from now, or has no expiry, return it.
4. Otherwise refresh through a `Map<provider, Promise<string>>`, so concurrent callers share one refresh.

Refresh errors are classified with Arctic's error types:
- `OAuth2RequestError` (the provider answered with an OAuth error such as `invalid_grant`) sets `error` with the provider's description.
- `ArcticFetchError` and unexpected responses (5xx, non-JSON) are transient. They reject the call and leave the state as it is.

A refresh whose connection was saved with another client (tokens cleared) or deleted while it was out discards its outcome. It neither writes the old client's tokens back nor sets `error` on the new connection. A response without a refresh token keeps the old one. Providers without refresh, or a connection without a refresh token, move to `error` ("expired, reconnect") once the token expires.

The SDK gets `OAuthError extends Error { kind }`, next to `LlmError`. `ModuleContext.oauth` is `{ token(provider: string): Promise<string> }`. `module-host.ts` passes `oauth: tokens.forModule(id)`. `createContext`'s default rejects with `not_connected` ("OAuth connections are not available in this host"), which covers the remote runner.

### 8. Test host

`TestHostOptions.oauth?: Record<string, string | OAuthError | (() => string | OAuthError | Promise<string>)>`. The test host enforces the manifest-request rule like core and counts calls per provider (`host.oauthCalls`). This is enough for the Spotify module's tests, which also use an injectable `fetch` (as travel and calendar do) for Spotify's responses.

### 9. Portal

New `pages/settings/ConnectionsPage.vue`, a route `/settings/connections`, and a sidebar entry after `Configuration`. The page uses the same table and drawer components as the Configuration page. The page itself is new, so `ConfigurationPage.vue` (edited by `agents`) is untouched. `Connect`/`Reconnect` does a full-page navigation to `/api/oauth/<id>/authorize`, after saving unsaved fields. On return, `?provider=` opens the drawer and shows the outcome, and the query is then removed from the URL.

### 10. Spotify module

`modules/spotify`, modelled on `modules/travel`:
- `src/spotify.ts`: a client over an injectable `fetch`, with a 10 s `AbortSignal.timeout` and a `SpotifyError` per status class.
- `src/tools.ts`: the two tools.
- `src/index.ts`: the manifest with `oauth: [{ provider: "spotify", scopes: ["playlist-read-private", "playlist-read-collaborative"], description }]`.

Search uses `GET /v1/search?type=track,artist,album&limit=10`, playlists `GET /v1/me/playlists?limit=50`. Results are mapped to the compact shapes in the spec. The module is added to `packages/core/src/modules.ts` after `travel`.

## Risks / Trade-offs

- [One token per provider, so grants are not scope-enforced] → A granted module can call any endpoint the token allows. This is acceptable because only your own in-process modules can be granted. The page shows each module's requested scopes, so you can see when a grant widens the login.
- [Arctic upgrades change class names or signatures] → The catalogue test (decision 2) fails CI. Pin `arctic` to a minor range in `@friday/core`.
- [Spotify's Web API and development-mode rules change often (endpoints deprecated for new apps, limits on users of development-mode apps)] → During apply, check the search and playlists endpoints and their fields against the current Web API reference before mapping. Record the Spotify app setup (development mode, add your own account) in the README.
- [Pending authorizations are in memory] → A restart during a login drops it, and the callback answers with an "authorization expired, try again" error. With one replica, nothing else needs shared state.
- [Refresh-token rotation and a crash between receiving and storing] → The new refresh token is stored in the same transaction as the access token, before it is returned. A crash before the write leaves the old, possibly rotated-out refresh token, and the next refresh fails into `error` → Reconnect. Rare, and visible when it happens.
- [`X-Forwarded-*` spoofing] → Only affects the user's own authorization request (decision 6). Setting `FRIDAY_PUBLIC_URL` in `deploy/k8s.yaml` removes the dependency on headers in production.

## Migration Plan

1. Deploy. Migration 10 creates empty tables, and nothing changes until a connection is made.
2. Set `FRIDAY_PUBLIC_URL=https://friday.thewhite.nl` in `deploy/k8s.yaml`, or in the portal under core.
3. Create a Spotify app at developer.spotify.com with redirect URI `https://friday.thewhite.nl/api/oauth/spotify/callback`. Enter its client id and secret under Settings > Connections, grant `spotify`, and click Connect.

Rollback: the previous image ignores the new tables. Spotify's tools disappear with the module.
