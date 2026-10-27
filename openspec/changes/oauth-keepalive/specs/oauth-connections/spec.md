# Spec Delta

## ADDED Requirements

### Requirement: Logins are kept alive

Core SHALL register a `core` job `oauth-keepalive` that runs every night at 05:00 in `FRIDAY_TIMEZONE`, as specified in `background-jobs`. Each run SHALL refresh the access token of every connection that is `connected`, has a stored refresh token, and whose provider can refresh, whether or not a module has asked for its token since the last run. It SHALL refresh one connection at a time, with the scopes a refresh for a module would ask for, and SHALL follow the refresh rules of "Access tokens for modules":
- a refresh already in progress for the connection SHALL be shared, not repeated;
- a successful refresh SHALL store the new access token and expiry, and the new refresh token when the provider sent one;
- a refresh the provider rejects SHALL set the connection to `error` with the provider's message;
- a network failure or a provider server error SHALL leave the connection `connected`;
- a refresh that finishes after the connection was saved with another client, or deleted, SHALL discard its outcome.

The run SHALL skip, without changing them, connections that are `disconnected` or in `error`, connections without a refresh token, and connections whose provider cannot refresh. A stored value that fails to decrypt SHALL put that connection in `error`, as when a module asks for its token. When `FRIDAY_MASTER_KEY` is unset, the run SHALL refresh nothing and SHALL say so in its summary. The run SHALL stop between connections when its signal is aborted.

The run's summary SHALL give the number of connections refreshed, the providers that now need a reconnect with the reason, and the providers whose refresh will be retried at the next run. The run SHALL be `failed` when at least one connection went to `error` during it, with the same text as its error, and `ok` otherwise. Neither the summary nor the logs SHALL contain a token or a client secret.

#### Scenario: Nightly refresh of an unused connection
- **WHEN** Spotify is `connected` with a refresh token, and no module has asked for its token for a week
- **THEN** the 05:00 run refreshes it, the connection stays `connected` with a later `expiresAt`, and the run is `ok` with a summary counting one refreshed connection

#### Scenario: Revoked at the provider
- **WHEN** the user revoked Friday at Spotify and the nightly run refreshes Spotify
- **THEN** the connection shows `error` with Spotify's message and offers `Reconnect`, and the run is `failed` naming Spotify and the reason

#### Scenario: Provider unreachable
- **WHEN** the refresh request for Spotify fails with a network error during the run
- **THEN** Spotify stays `connected`, the run is `ok`, and its summary names Spotify as retried at the next run

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
