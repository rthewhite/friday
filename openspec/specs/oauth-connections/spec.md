# oauth-connections Specification

## Purpose
Lets the user log Friday in to OAuth services such as Spotify, keeps the tokens fresh, and hands a provider's access token only to the in-process modules the user granted access to.

## Requirements

### Requirement: Connections are stored encrypted

Core SHALL store at most one connection per provider id in `friday.db`, with the provider id, the client id, the client secret (optional), extra scopes, for `generic` providers the authorization and token URLs, the access and refresh tokens, the access token's expiry, the scopes the provider granted, a state (`disconnected`, `connected` or `error`), an error message, and creation and update times. The client secret and both tokens SHALL be encrypted with AES-256-GCM using `FRIDAY_MASTER_KEY`, a random IV per value, and additional authenticated data that binds each value to its provider and field. The client id SHALL be stored plain. When `FRIDAY_MASTER_KEY` is unset, creating or updating a connection and starting an authorization SHALL fail with 503 and a message, and `ctx.oauth.token` SHALL reject with `not_connected` stating that the master key is missing. A value that fails to decrypt SHALL be logged and SHALL put the connection in state `error`.

#### Scenario: Tokens at rest
- **WHEN** Spotify is connected
- **THEN** the stored client secret, access token and refresh token are ciphertext, and the client id is readable

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset and the user saves a Spotify connection
- **THEN** the response is 503 with a message naming `FRIDAY_MASTER_KEY`

#### Scenario: Wrong master key
- **WHEN** the tokens were encrypted with a different key and a module asks for the Spotify token
- **THEN** the error is logged, the connection shows `error`, and the module's call rejects with `refresh_failed`

### Requirement: Provider catalogue

Core SHALL offer every provider of its OAuth library that has a standard client constructor (client id, optional client secret, redirect URI), each with an id, a display name, whether it uses PKCE and whether it can refresh tokens, and SHALL offer `generic` for any other OAuth2 provider. A connection whose provider id is not in the catalogue SHALL be a generic connection: it SHALL require an `https` authorization URL and token URL, and SHALL use the authorization code flow with PKCE (S256) and space-separated scopes. Every catalogue provider SHALL be able to build an authorization URL. `GET /api/oauth/providers` SHALL return the catalogue as `{ id, name, pkce, refresh }` sorted by name, followed by `generic`.

#### Scenario: Catalogue provider
- **WHEN** the user creates a connection for `github`
- **THEN** no authorization or token URL is asked for, and the authorization uses GitHub's endpoints

#### Scenario: Generic provider
- **WHEN** the user creates a connection `acme` with authorization URL `https://acme.example/authorize` and token URL `https://acme.example/token`
- **THEN** the connection is saved and authorizing sends the browser to `https://acme.example/authorize` with `code_challenge_method=S256`

#### Scenario: Generic without URLs
- **WHEN** the user creates a connection `acme` without a token URL
- **THEN** the response is 400 naming the missing URL

#### Scenario: Plain HTTP refused
- **WHEN** a generic connection's token URL is `http://acme.example/token`
- **THEN** the response is 400 stating that the URL must be https

### Requirement: Modules request access

The in-process modules' manifests SHALL be the source of requests: each `oauth` entry names a provider, the scopes the module needs and why. Core SHALL list, per provider, the modules requesting it with their scopes, description and whether they are granted, including providers that no connection exists for yet. A request SHALL NOT be stored and SHALL disappear when the module is no longer in core's list or is disabled. A disabled module's grants SHALL be kept, so its request comes back granted when it is enabled again. When a request for a provider without a connection carries an authorization and token URL, those URLs SHALL be offered as the defaults for creating the connection; the stored connection's URLs SHALL be the ones used.

#### Scenario: Request without a connection
- **WHEN** the `spotify` module requests `spotify` and no Spotify connection exists
- **THEN** the connections listing has a `spotify` entry with `configured: false` and `spotify` among its requesters, not granted

#### Scenario: Module removed
- **WHEN** a module requesting `github` is removed from core's list and no `github` connection exists
- **THEN** the listing has no `github` entry

#### Scenario: Module disabled
- **WHEN** the `spotify` module, granted on the `spotify` connection, is disabled
- **THEN** `spotify` is no longer among the connection's requesters, and when the module is enabled again it is listed as granted

#### Scenario: Generic defaults from a manifest
- **WHEN** a module requests provider `acme` with an authorization and token URL and the user opens it in the portal
- **THEN** the create form is filled in with both URLs

### Requirement: Grants per module

The user SHALL grant or revoke a module's access per connection. A grant SHALL be possible only for a module that requests the provider and only when the connection exists; otherwise the API SHALL respond 404. A revoke SHALL take effect for the next `ctx.oauth.token` call. Deleting a connection SHALL delete its grants. A grant SHALL remain stored while its module is temporarily absent from core's list, and SHALL apply again when the module returns.

#### Scenario: Grant
- **WHEN** Spotify is connected and the user grants `spotify`
- **THEN** the next `ctx.oauth.token("spotify")` in the `spotify` module resolves to an access token

#### Scenario: Not granted
- **WHEN** Spotify is connected and a module that requests it has no grant
- **THEN** its `ctx.oauth.token("spotify")` rejects with `not_granted`, with a message saying to grant it under Settings > Connections

#### Scenario: Revoke
- **WHEN** the user revokes `spotify`'s grant
- **THEN** its next `ctx.oauth.token("spotify")` rejects with `not_granted`, without a reload

#### Scenario: Grant for a non-requester
- **WHEN** a grant is requested for `travel` on `spotify` and `travel` does not request `spotify`
- **THEN** the response is 404

### Requirement: Scopes follow the grants

The scopes Friday requests when authorizing SHALL be the union of the scopes requested by the modules granted on that connection and the connection's extra scopes, without duplicates. After an authorization, the connection SHALL record the scopes the provider reports as granted, or the requested scopes when the provider reports none. The connection SHALL report as missing every scope in the current union that the recorded scopes lack, each with the modules that requested it, and the portal SHALL offer `Reconnect` while any scope is missing. A missing scope SHALL NOT stop `ctx.oauth.token` from returning the token.

#### Scenario: Union of granted modules
- **WHEN** `spotify` (granted) requests `playlist-read-private` and `user-read-email` is an extra scope
- **THEN** authorizing asks Spotify for `playlist-read-private` and `user-read-email`

#### Scenario: Ungranted requests don't widen the login
- **WHEN** a second module requests `user-modify-playback-state` but is not granted
- **THEN** authorizing does not ask for `user-modify-playback-state`

#### Scenario: Grant that needs a new scope
- **WHEN** Spotify is connected for `playlist-read-private` and the user grants a module requesting `user-modify-playback-state`
- **THEN** the connection lists `user-modify-playback-state` as missing for that module and offers `Reconnect`

#### Scenario: Provider grants less
- **WHEN** the provider's token response grants only some of the requested scopes
- **THEN** the connection records those and lists the rest as missing

### Requirement: Authorization flow

`GET /api/oauth/:provider/authorize` SHALL require an existing connection (404 otherwise). When the redirect URI's base (see Redirect URI) has another origin than the request, it SHALL first redirect the browser to the same path on that base, so the state cookie is set on the host the provider returns to; a request that already made that move SHALL proceed rather than redirect again. It SHALL then create a random `state` value, store it with the redirect URI and, when the provider uses PKCE, a code verifier, for 10 minutes, set it in an `HttpOnly`, `SameSite=Lax` cookie scoped to `/api/oauth`, and redirect the browser to the provider's authorization URL with the scopes from the grants. `GET /api/oauth/:provider/callback` SHALL reject a missing or unknown `state`, a `state` that differs from the cookie, a `state` issued for another provider, or an expired `state`, without contacting the provider. A valid callback SHALL exchange the code using the stored redirect URI and verifier, store the tokens, the expiry and the granted scopes, set the state to `connected`, and clear the error. Only the client secret SHALL be read for a login, so tokens that cannot be decrypted do not block the login that replaces them. A callback for a connection saved with another client id since the login started SHALL be refused, and its tokens discarded. A `state` SHALL be usable once. Every outcome SHALL redirect to `/settings/connections?provider=<id>` with `connected=1`, or with `error=<message>`. When the provider was contacted and failed, a connection without a working login SHALL show state `error` with that message; a connected connection SHALL keep its tokens and state, so a failed Reconnect does not break a working login. An `error` parameter from the provider, such as the user declining, SHALL be shown the same way without changing a connected connection's tokens.

#### Scenario: Connect Spotify
- **WHEN** the user clicks `Connect` on Spotify, logs in at Spotify and approves
- **THEN** the browser returns to `/settings/connections?provider=spotify&connected=1` and the connection shows `connected` with its granted scopes

#### Scenario: Forged callback
- **WHEN** a callback arrives with a `state` that does not match the cookie
- **THEN** no request is made to Spotify, no token is stored, and the browser is redirected with an error

#### Scenario: State reused
- **WHEN** a callback is replayed with a `state` that was already used
- **THEN** it is rejected without contacting the provider

#### Scenario: User declines
- **WHEN** Spotify redirects back with `error=access_denied` while the connection is `connected`
- **THEN** the portal shows the error and the stored tokens still work

#### Scenario: Code exchange fails
- **WHEN** the provider rejects the code for a connection that is not connected
- **THEN** the connection shows `error` with the provider's message

#### Scenario: Reconnect fails
- **WHEN** Spotify is connected, the user clicks `Reconnect` and the code exchange fails
- **THEN** the portal shows the error and Spotify stays `connected` with its tokens

#### Scenario: Opened at another address
- **WHEN** `FRIDAY_PUBLIC_URL` is `https://friday.thewhite.nl` and the user clicks `Connect` in the portal opened at `http://192.168.1.81:8080`
- **THEN** the browser goes to `https://friday.thewhite.nl/api/oauth/spotify/authorize` first, and the state cookie is set there

#### Scenario: Unreadable token
- **WHEN** the stored access token cannot be decrypted and the user clicks `Reconnect`
- **THEN** the login proceeds and its tokens replace the unreadable ones

### Requirement: Redirect URI

The redirect URI SHALL be `<base>/api/oauth/<provider>/callback`, where `<base>` is core's `FRIDAY_PUBLIC_URL` without a trailing slash, or, when it is unset, the origin of the request, using `X-Forwarded-Proto` and `X-Forwarded-Host` when present. A `FRIDAY_PUBLIC_URL` that is not an absolute `http` or `https` URL SHALL be ignored with a logged warning. The connections listing SHALL include the base as `redirectBase` and each connection's redirect URI, as computed for the listing request, so the user can register it with the provider.

#### Scenario: Public URL set
- **WHEN** `FRIDAY_PUBLIC_URL` is `https://friday.thewhite.nl/`
- **THEN** Spotify's redirect URI is `https://friday.thewhite.nl/api/oauth/spotify/callback`

#### Scenario: Behind the proxy without a public URL
- **WHEN** `FRIDAY_PUBLIC_URL` is unset and the request arrives with `X-Forwarded-Proto: https` and host `friday.thewhite.nl`
- **THEN** the redirect URI starts with `https://friday.thewhite.nl/`

#### Scenario: Local development
- **WHEN** the portal is opened at `http://127.0.0.1:5173`
- **THEN** the listed redirect URI is `http://127.0.0.1:5173/api/oauth/spotify/callback`

#### Scenario: Public URL without a scheme
- **WHEN** `FRIDAY_PUBLIC_URL` is `friday.thewhite.nl`
- **THEN** a warning is logged and redirect URIs use the request's origin

### Requirement: Access tokens for modules

`ctx.oauth.token(provider)` SHALL resolve to an access token when the calling module requests the provider in its manifest, holds a grant, and the connection is `connected`. It SHALL reject with an `OAuthError` of kind:
- `not_granted` when the module does not request the provider or holds no grant;
- `not_connected` when no connection exists, the connection is `disconnected`, or the master key is missing;
- `refresh_failed` when the connection is in state `error` or a needed refresh fails.

Each message SHALL name the provider and what the user can do, under Settings > Connections, so a tool can pass it on to the user. When the access token expires within 60 seconds, the call SHALL refresh it first. Concurrent calls SHALL share one refresh per connection. A refresh response without a refresh token SHALL keep the stored one. A refresh that the provider rejects SHALL set the connection to `error` with the provider's message. A network failure or a provider server error SHALL reject the call with `refresh_failed` and leave the state unchanged. A refresh that finishes after the connection was saved with another client, or deleted, SHALL discard its outcome and reject with `not_connected`. A connection whose provider cannot refresh, or that has no refresh token, SHALL set the state to `error` when its token expires. Tokens SHALL never be returned by the HTTP API or written to logs.

#### Scenario: Fresh token
- **WHEN** the stored access token expires in 30 minutes
- **THEN** `ctx.oauth.token("spotify")` returns it without contacting Spotify

#### Scenario: Refresh
- **WHEN** the stored access token expires in 30 seconds
- **THEN** the call refreshes it, stores the new token and expiry, and returns the new token

#### Scenario: One refresh for concurrent calls
- **WHEN** two tools call `ctx.oauth.token("spotify")` at the same time with an expired token
- **THEN** Spotify receives one refresh request and both calls get the new token

#### Scenario: Refresh revoked
- **WHEN** the user revoked Friday at Spotify and a refresh is attempted
- **THEN** the call rejects with `refresh_failed`, and the connection shows `error` with Spotify's message and offers `Reconnect`

#### Scenario: Provider unreachable
- **WHEN** the refresh request fails with a network error
- **THEN** the call rejects with `refresh_failed` and the connection stays `connected`

#### Scenario: Not set up
- **WHEN** no Spotify connection exists and the module asks for the token
- **THEN** the call rejects with `not_connected`, with a message saying to connect Spotify under Settings > Connections

### Requirement: Connections API

Core SHALL expose:
- `GET /api/oauth/connections`: `{ secretsEnabled, redirectBase, connections }` with one entry per provider that has a connection or a request: `provider`, `name`, `configured`, `generic`, `clientId`, `hasClientSecret`, `authUrl` and `tokenUrl` (generic only, from the connection or the first request's defaults), `extraScopes`, `requestedScopes` (the union from the grants), `grantedScopes`, `missingScopes` (each `{ scope, modules }`), `requesters` (each `{ module, scopes, description, granted }`), `state`, `error`, `expiresAt`, `redirectUri`, `updatedAt`. Entries SHALL never include the client secret or a token.
- `PUT /api/oauth/connections/:provider` with `{ clientId, clientSecret?, extraScopes?, authUrl?, tokenUrl? }`: create or update. A new connection starts `disconnected`. Changing the client id, client secret or a URL SHALL clear the tokens and set `disconnected`. Leaving `clientSecret` out SHALL keep the stored one, except that changing a URL of a connection with a stored client secret SHALL require the secret again (400 otherwise), so the stored secret is never sent to a new token URL. Changing only `extraScopes` SHALL keep the tokens.
- `DELETE /api/oauth/connections/:provider`: delete the connection, its tokens and grants; 404 when absent.
- `PUT` and `DELETE /api/oauth/connections/:provider/grants/:module`: grant and revoke.

Provider ids SHALL be kebab-case and SHALL NOT be `connections` or `providers`, which name the API's own paths. Invalid bodies SHALL be answered with 400 and a message.

#### Scenario: Listing hides secrets
- **WHEN** Spotify is connected and the connections are listed
- **THEN** the entry has `clientId`, `hasClientSecret: true`, its scopes and expiry, and no secret or token

#### Scenario: New client secret
- **WHEN** the user saves a new client secret for a connected Spotify connection
- **THEN** the tokens are cleared and the connection shows `disconnected`

#### Scenario: Extra scope added
- **WHEN** the user adds an extra scope to a connected connection
- **THEN** the tokens are kept and the scope is listed as missing

#### Scenario: Reserved provider id
- **WHEN** a connection is saved with provider id `connections`
- **THEN** the response is 400

#### Scenario: Delete
- **WHEN** the user deletes the Spotify connection
- **THEN** its tokens and grants are gone and `spotify`'s next token call rejects with `not_connected`

### Requirement: Connections page

The portal SHALL provide `System > Connections` at `/settings/connections` with one table row per listing entry: status dot (`connected`, `disconnected`, `error`, or not set up), provider name, requester chips (granted ones marked), scopes summary and updated. Clicking a row SHALL open a drawer with:
- for an entry without a connection, a provider selector (catalogue and `generic`) preset to the entry's provider, and authorization and token URLs for generic providers, prefilled from the request;
- the client id and client secret (masked when stored, never displayed; blank keeps it);
- the redirect URI with a copy action;
- the extra scopes;
- one grant toggle per requesting module, with its scopes and description;
- the missing scopes with the modules that need them;
- the state and error;
- actions `Save`, `Connect` (or `Reconnect` when tokens exist or scopes are missing), and `Delete` after confirmation.

A header action SHALL create a connection for a provider no module requests. Returning from the provider with `?provider=<id>` SHALL open that drawer and show `connected` or the error. When `FRIDAY_MASTER_KEY` is unset, the page SHALL show the secrets banner and SHALL NOT allow saving or connecting.

#### Scenario: Set up Spotify
- **WHEN** the `spotify` module requests Spotify, the user opens the row, enters the client id and secret, saves, turns on `spotify`'s grant and clicks `Connect`
- **THEN** after the Spotify login the drawer shows `connected` and `spotify` granted

#### Scenario: Missing scope prompt
- **WHEN** a connected connection has a missing scope
- **THEN** the row shows that the connection needs a reconnect, and the drawer names the scope and the module and offers `Reconnect`

#### Scenario: Redirect URI to register
- **WHEN** the user opens a connection
- **THEN** the drawer shows the exact redirect URI to enter at the provider and copies it on click

### Requirement: Logins are kept alive

Core SHALL register a `core` job `oauth-keepalive` that runs every night at 05:00 in `FRIDAY_TIMEZONE`, as specified in `background-jobs`. Each run SHALL refresh the access token of every connection that is `connected`, has a stored refresh token, and whose provider can refresh, whether or not a module has asked for its token since the last run. It SHALL refresh one connection at a time, and SHALL move on to the next connection, counting the refresh as one to retry, when a provider has not answered within 30 seconds. It SHALL ask for the scopes the provider reported granting the stored token, so keeping a login alive never narrows it, or, when the provider reported none, for the scopes a refresh for a module would ask for. It SHALL follow the refresh rules of "Access tokens for modules":
- a refresh already in progress for the connection SHALL be shared, not repeated;
- a successful refresh SHALL store the new access token and expiry, and the new refresh token when the provider sent one;
- a refresh the provider rejects SHALL set the connection to `error` with the provider's message;
- a network failure, a provider server error, or any other failure that is not a refusal SHALL leave the connection `connected`, and SHALL NOT stop the refresh of the other connections;
- a refresh that finishes after the connection was saved with another client, or deleted, SHALL discard its outcome.

The run SHALL skip, without changing them, connections that are `disconnected` or in `error`, connections without a refresh token, and connections whose provider cannot refresh. A stored value that fails to decrypt SHALL put that connection in `error`, as when a module asks for its token. When `FRIDAY_MASTER_KEY` is unset, the run SHALL refresh nothing and SHALL say so in its summary. The run SHALL stop between connections when its signal is aborted.

The run's summary SHALL give the number of connections refreshed, the skipped `connected` providers with the reason, the providers that now need a reconnect with the reason, the providers whose refresh will be retried at the next run, and the providers that were already in `error` when the run started. The run SHALL be `failed` when at least one connection went to `error` during it, with the same text as its error, and `ok` otherwise. Neither the summary nor the logs SHALL contain a token or a client secret.

#### Scenario: Nightly refresh of an unused connection
- **WHEN** Spotify is `connected` with a refresh token, and no module has asked for its token for a week
- **THEN** the 05:00 run refreshes it, the connection stays `connected` with a later `expiresAt`, and the run is `ok` with a summary counting one refreshed connection

#### Scenario: Revoked at the provider
- **WHEN** the user revoked Friday at Spotify and the nightly run refreshes Spotify
- **THEN** the connection shows `error` with Spotify's message and offers `Reconnect`, and the run is `failed` naming Spotify and the reason

#### Scenario: Provider unreachable
- **WHEN** the refresh request for Spotify fails with a network error during the run
- **THEN** Spotify stays `connected`, the run is `ok`, and its summary names Spotify as retried at the next run

#### Scenario: Provider does not answer
- **WHEN** Dropbox's token endpoint accepts the request but never answers, and Spotify is connected too
- **THEN** after 30 seconds the run moves on and refreshes Spotify, Dropbox stays `connected`, and the run is `ok` naming Dropbox as retried at the next run

#### Scenario: Broken on an earlier night
- **WHEN** Spotify went to `error` in last night's run and has not been reconnected
- **THEN** tonight's run makes no request for Spotify, is `ok` when nothing else broke, and its summary names Spotify as still needing a reconnect

#### Scenario: Scopes are kept
- **WHEN** a connection's token was granted `a` and `b`, and no module holds a grant on it any more
- **THEN** the nightly refresh asks for `a` and `b`

#### Scenario: Shared with a module's call
- **WHEN** a tool calls `ctx.oauth.token("spotify")` for an expiring token while the run is refreshing Spotify
- **THEN** Spotify receives one refresh request, and the tool and the run both use its outcome

#### Scenario: Connections that are skipped
- **WHEN** one connection is `disconnected`, one is in `error`, and one belongs to a provider that cannot refresh
- **THEN** the run makes no request for any of them, their state is unchanged, and the run is `ok`

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset and the job runs
- **THEN** no refresh is attempted and the run is `ok` with a summary naming `FRIDAY_MASTER_KEY`

#### Scenario: Run now
- **WHEN** the user starts `core/oauth-keepalive` from the Jobs page
- **THEN** it runs with trigger `manual` and refreshes the eligible connections, and the next scheduled run is still 05:00
