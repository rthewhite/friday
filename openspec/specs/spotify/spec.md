# spotify Specification

## Purpose
Lets Friday search Spotify and list the user's playlists through the Spotify Web API, as the `spotify` module, using the Spotify OAuth connection the user granted it.

## Requirements

### Requirement: Spotify module and access request

An in-process module with id `spotify` SHALL register `search_spotify` and `list_spotify_playlists`, offered on every channel. Its manifest SHALL request the `spotify` provider with the scopes `playlist-read-private` and `playlist-read-collaborative` and a description saying what they are for. The module SHALL declare no configuration keys and SHALL load whether or not Spotify is connected or granted. It SHALL get the access token through `ctx.oauth.token("spotify")` on every call. When that rejects, the tool SHALL fail with the `OAuthError`'s message, so the user hears what to do in Settings > Connections. The token SHALL NOT appear in logs, tool results or error messages.

#### Scenario: Loaded before Spotify is set up
- **WHEN** Friday starts with no Spotify connection
- **THEN** the `spotify` module is `loaded`, and the Connections page lists Spotify as requested by `spotify`

#### Scenario: Not granted yet
- **WHEN** Spotify is connected but `spotify` has no grant and `search_spotify` is called
- **THEN** the tool fails with a message saying to grant Spotify access to `spotify` under Settings > Connections

#### Scenario: Granted later
- **WHEN** the user grants `spotify` after a failed call
- **THEN** the next call succeeds without reloading the module

### Requirement: Search

`search_spotify` SHALL take a required `query` and return the first 10 matches of each kind: `tracks` (`name`, `artist`, `album`, `uri`), `artists` (`name`, `uri`) and `albums` (`name`, `artist`, `year`, `uri`). `artist` SHALL be the first listed artist. An empty or whitespace-only query SHALL be refused without calling Spotify. No matches SHALL be an empty list per kind, not an error. The description SHALL say the tool is for finding things and their URIs, that it does not play music, and that a URI can be passed to a playback tool to play it.

#### Scenario: Search an artist
- **WHEN** called with `query: "Radiohead"`
- **THEN** the result has `artists` starting with Radiohead and its `spotify:artist:` URI, plus matching tracks and albums

#### Scenario: Nothing found
- **WHEN** Spotify returns no items
- **THEN** the result has empty `tracks`, `artists` and `albums`

### Requirement: Playlists

`list_spotify_playlists` SHALL take no parameters and return the user's playlists, owned and followed, up to 50, each with `name`, `description` (omitted when empty), `owner`, `tracks` (the item count) and `uri`.

#### Scenario: List playlists
- **WHEN** the user has 3 playlists
- **THEN** the result lists all 3 with their names, owners, counts and URIs

### Requirement: Spotify errors are explained

Every Spotify request SHALL time out after 10 seconds. A failed request SHALL fail the tool with a message naming the cause:
- 401: Spotify rejected the login, so reconnect Spotify under Settings > Connections;
- 403: the connection lacks a permission or the Spotify app does not allow this account, with Spotify's message;
- 429: Spotify is rate-limiting, with the wait from `Retry-After` when given;
- other statuses and timeouts: Spotify is unavailable, with the status.

#### Scenario: Login rejected
- **WHEN** Spotify answers 401
- **THEN** the tool fails with a message saying to reconnect Spotify under Settings > Connections

#### Scenario: Rate limited
- **WHEN** Spotify answers 429 with `Retry-After: 30`
- **THEN** the tool fails with a message saying Spotify asked to wait 30 seconds

### Requirement: Spotify is the owner's

Until users have their own connections, every Spotify tool SHALL be declared owner-only (as specified in `data-ownership`), because the connection is the owner's account.

#### Scenario: Member asks for playlists
- **WHEN** member `Sanne` asks in chat for her Spotify playlists
- **THEN** her turn offers no Spotify tools
