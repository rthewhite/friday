# Media Playback

## Purpose

Voice control of a Jellyfin library played through Infuse on an Apple TV, with the Apple TV controlled via Home Assistant. Tools chain naturally: "continue Band of Brothers" → `search_library` / `get_next_episode` → `play_on_apple_tv`.

## Requirements

### Requirement: Jellyfin configuration and authentication

Jellyfin tools SHALL use `JELLYFIN_URL` and `JELLYFIN_API_KEY`, authenticate with a `MediaBrowser Token` header, and time out requests that hang. Trailing slashes on URLs SHALL be stripped.

#### Scenario: Not configured
- **WHEN** `JELLYFIN_URL` or `JELLYFIN_API_KEY` is missing
- **THEN** any Jellyfin tool returns an error naming the missing configuration

#### Scenario: Non-2xx response
- **WHEN** Jellyfin responds with a non-OK status
- **THEN** the tool returns an error that includes the request path and status

### Requirement: Jellyfin user resolution

The acting user SHALL be resolved once per process and cached: the user whose display name case-insensitively matches `JELLYFIN_USER`, or the first user when `JELLYFIN_USER` is unset.

#### Scenario: Named user
- **WHEN** `JELLYFIN_USER=Alice` and a user named `alice` exists
- **THEN** that user's id is used

#### Scenario: Unknown user
- **WHEN** `JELLYFIN_USER` matches no user
- **THEN** the tool returns an error naming the user that was not found

#### Scenario: No user configured
- **WHEN** `JELLYFIN_USER` is unset
- **THEN** the first user returned by Jellyfin is used

### Requirement: Compact item representation

Items returned to the model SHALL be reduced to: `id`, `type`, `series`, `season`, `episode`, `title`, `year`, `added` (YYYY-MM-DD), `minutes` (runtime), `watched`, `resume_at_minutes`, `unplayed_episodes`. Fields that are empty, zero or false SHALL be omitted to keep results compact.

#### Scenario: Partially watched episode
- **WHEN** an item has a non-zero playback position
- **THEN** `resume_at_minutes` is the position rounded to whole minutes

#### Scenario: Unwatched movie
- **WHEN** an item is not played
- **THEN** `watched` is omitted from the output

### Requirement: search_library

The tool SHALL search Jellyfin recursively by `query` for `type` `series`, `movie`, or `any` (default), returning up to `limit` (default 6) compact results including year and watch state.

#### Scenario: Search for a series
- **WHEN** called with `query: "Band of Brothers", type: "series"`
- **THEN** `results` contains matching series with `unplayed_episodes`

#### Scenario: Default type
- **WHEN** `type` is omitted
- **THEN** both series and movies are searched

### Requirement: get_next_episode

Given a `series` (name or 32-hex Jellyfin id), the tool SHALL pick the episode to continue with: the Jellyfin Next Up result (resumable enabled) with reason `resume partially watched` or `next unwatched`; otherwise the first unplayed episode with reason `first episode`; if all are played, episode 1 with reason `all watched, starting over`.

#### Scenario: Series by name
- **WHEN** called with a name that matches one series
- **THEN** the result contains `series`, `reason`, and a compact `episode`

#### Scenario: Ambiguous name
- **WHEN** the name matches more than one series
- **THEN** the best match is used and `other_matches` lists the alternatives so the model can ask the user to disambiguate

#### Scenario: Series by id
- **WHEN** called with a 32-character hex id
- **THEN** no search is performed and the id is used directly

#### Scenario: No match
- **WHEN** no series matches the name
- **THEN** the result is an error stating that no series matched

#### Scenario: Partially watched
- **WHEN** Next Up returns an episode with a playback position
- **THEN** `reason` is `resume partially watched`

#### Scenario: Everything watched
- **WHEN** Next Up is empty and all episodes are played
- **THEN** the first episode is returned with reason `all watched, starting over`

#### Scenario: Series without episodes
- **WHEN** the series has no episodes
- **THEN** the result is an error stating the series has no episodes

### Requirement: list_episodes_to_watch

The tool SHALL return `{ kind, episodes }` where `kind` is `next_up` (default: Jellyfin Next Up across shows in progress) or `recently_added` (latest added episodes, ungrouped), limited to `limit` (default 8).

#### Scenario: Next up
- **WHEN** called without arguments
- **THEN** up to 8 Next Up episodes are returned with `kind: "next_up"`

#### Scenario: Recently added
- **WHEN** called with `kind: "recently_added"`
- **THEN** the most recently added episodes are returned individually, not grouped by series

### Requirement: play_on_apple_tv

Given an `item_id`, the tool SHALL build a Jellyfin direct stream URL from `JELLYFIN_PUBLIC_URL` (default `JELLYFIN_URL`) embedding the API key, wrap it in an Infuse deep link `infuse://x-callback-url/play?url=<encoded stream>`, verify the Apple TV entity in Home Assistant, turn it on, send the deep link as `play_media` with content type `url`, and then mark the item played in Jellyfin.

#### Scenario: Successful playback
- **WHEN** the entity exists and is available
- **THEN** `media_player.turn_on` and `media_player.play_media` are called, the item is marked played, and the result is `{ started: true, marked_watched: true }` with scheduling `SILENT`

#### Scenario: Mark played fails
- **WHEN** playback starts but marking the item played fails
- **THEN** the result is `{ started: true, marked_watched: false, warning }` with scheduling `WHEN_IDLE`

#### Scenario: Entity not configured
- **WHEN** `HA_APPLE_TV_ENTITY` is unset
- **THEN** the result is `{ started: false, error }` naming the missing configuration, with scheduling `INTERRUPT`

#### Scenario: Entity missing
- **WHEN** Home Assistant has no state for the entity
- **THEN** the result is `{ started: false, error }` naming the missing entity, with scheduling `INTERRUPT`, and no service is called

#### Scenario: Entity unavailable
- **WHEN** the entity state is `unavailable` or `unknown`
- **THEN** the result is `{ started: false, error }` reporting that state, and no service is called

#### Scenario: Home Assistant call fails
- **WHEN** `turn_on` or `play_media` returns a non-OK status
- **THEN** the result is `{ started: false, error }` with scheduling `INTERRUPT`

### Requirement: Home Assistant REST client

The client SHALL use `HA_URL` and `HA_TOKEN` (bearer auth). Service calls SHALL POST to `/api/services/<domain>/<service>`; state reads SHALL GET `/api/states/<entity>`. Requests SHALL time out rather than hang. Non-OK responses SHALL throw a descriptive error including the status and, for service calls, the response body.

#### Scenario: Not configured
- **WHEN** `HA_URL` or `HA_TOKEN` is missing
- **THEN** calls throw an error naming the missing configuration

#### Scenario: Service call error
- **WHEN** a service call returns non-OK
- **THEN** it throws an error identifying the service, the status and the response body

#### Scenario: State read error
- **WHEN** a state read returns non-OK
- **THEN** it throws an error identifying the entity and the status

### Requirement: Stream URLs stay on the LAN

Because the stream URL embeds the Jellyfin API key, the documentation SHALL warn that this setup is intended for a local network only.

#### Scenario: Documentation
- **WHEN** a user reads the Jellyfin setup section
- **THEN** it states the stream URL embeds the API key and should stay on the LAN
