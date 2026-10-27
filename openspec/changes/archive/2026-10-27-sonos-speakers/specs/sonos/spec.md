# Spec Delta

## Purpose

Plays Spotify music on the household's Sonos speakers, groups them for multi-room playback, and controls playback and volume, all through Home Assistant's Sonos integration. This is the `sonos` module's set of tools on voice and chat.

## ADDED Requirements

### Requirement: Sonos module and configuration

An in-process module with id `sonos` SHALL register the tools `sonos_list_speakers`, `sonos_play`, `sonos_pause`, `sonos_resume`, `sonos_stop`, `sonos_set_volume` and `sonos_ungroup`, each offered on the voice and chat channels. The module SHALL declare `HA_URL` and `HA_TOKEN` (secret) as required config keys, so it fails to load, with an error naming the missing keys, when either is unset. Both keys SHALL be read on every call, so a changed value is used from the next call on without a reload. The token SHALL NOT appear in logs, tool results or error messages.

#### Scenario: Not configured
- **WHEN** the module loads without `HA_TOKEN`
- **THEN** the module fails with an error naming `HA_TOKEN` and registers no tools

#### Scenario: Configured once for both modules
- **WHEN** `HA_URL` and `HA_TOKEN` are stored globally and both `media` and `sonos` are loaded
- **THEN** both modules use the same Home Assistant values

#### Scenario: Changed token
- **WHEN** the user saves a new `HA_TOKEN` while the module is loaded
- **THEN** the next call uses the new token without a module reload

### Requirement: Speakers come from Home Assistant

The speakers SHALL be the `media_player` entities of Home Assistant's `sonos` integration, read from Home Assistant on every tool call, with no cache kept between calls. Other media players SHALL NOT be speakers, including Home Assistant group entities and Sonos devices added through other integrations. Each speaker SHALL have: `name` (its Home Assistant friendly name), `area` (its Home Assistant area, omitted when it has none), `model` (omitted when unknown), `entity` (the entity id), `state` (the entity state, e.g. `playing`, `paused`, `idle`, `unavailable`), `volume` (0-100, rounded, omitted when unknown), and `group` (the names of every speaker in its Sonos group, leader first, omitted when it is not grouped with others).

#### Scenario: Group entity is not a speaker
- **WHEN** Home Assistant has `media_player.sonos_arc` from the `sonos` integration and a group entity `media_player.all_speakers`
- **THEN** only `media_player.sonos_arc` is a speaker

#### Scenario: Grouped speakers
- **WHEN** the Arc leads a group with the One SL
- **THEN** both speakers have `group` listing the Arc's name first, then the One SL's

#### Scenario: Speaker added in Home Assistant
- **WHEN** a speaker is added to the Sonos integration between two calls
- **THEN** the second call includes it without a module reload

### Requirement: Naming speakers

Tools that take `speakers` SHALL accept a list of references. Each reference SHALL be matched case-insensitively, ignoring accents and everything other than letters and digits (of any script), against first a speaker's entity id, then its name, then its area. An area SHALL match every speaker in that area that is not `unavailable`. The speakers matched by all references SHALL be used once each, in the order first referenced. A reference matching no speaker SHALL fail the call before any change is made, with an error that names the reference and lists the available speakers with their areas. An empty `speakers` list SHALL be refused where `speakers` is required. A command SHALL fail before any change, naming the speaker, when it names an `unavailable` speaker by entity id or name, or names an area whose speakers are all `unavailable`.

#### Scenario: By area
- **WHEN** `sonos_pause` is called with `speakers: ["bedroom"]` and the Playbar is in area `Bedroom`
- **THEN** the Playbar is paused

#### Scenario: By name with punctuation
- **WHEN** a speaker is named `[Hobby Room] Sonos` and the reference is `hobby room sonos`
- **THEN** that speaker is matched

#### Scenario: Area with several speakers
- **WHEN** two speakers are in area `Living Room` and the reference is `living room`
- **THEN** both are used

#### Scenario: Unknown speaker
- **WHEN** the reference is `kitchen` and no speaker or area matches it
- **THEN** the call fails with an error naming `kitchen` and listing the available speakers and their areas, and Home Assistant receives no service call

#### Scenario: Accents
- **WHEN** a speaker's area is `Küche` and the reference is `kuche`
- **THEN** that speaker is matched

#### Scenario: Unavailable speaker
- **WHEN** a speaker named by its name is `unavailable`
- **THEN** the call fails naming that speaker, and Home Assistant receives no service call

#### Scenario: Offline speaker in a room
- **WHEN** the reference is `living room`, the Arc there is available and a second speaker there is `unavailable`
- **THEN** only the Arc is used

#### Scenario: Whole room offline
- **WHEN** the reference is `living room` and every speaker there is `unavailable`
- **THEN** the call fails naming an unavailable speaker, and Home Assistant receives no service call

### Requirement: sonos_list_speakers

`sonos_list_speakers` SHALL return `{ speakers }`, every speaker with its fields as described above, and SHALL add `playing` (`title`, plus `artist` when known) for a speaker whose group is playing or paused something with a title. When there are no speakers, it SHALL return an empty list, not an error.

#### Scenario: Something is playing
- **WHEN** the Arc is playing a track titled `Karma Police` by `Radiohead`
- **THEN** the Arc's entry has `state: "playing"` and `playing: { title: "Karma Police", artist: "Radiohead" }`

#### Scenario: No speakers
- **WHEN** the Sonos integration has no entities
- **THEN** the result is `{ speakers: [] }`

### Requirement: sonos_play

`sonos_play` SHALL take `speakers` (required) and `uris` (required, 1 to 50 Spotify URIs or links). Each URI SHALL be a `spotify:<kind>:<id>` URI or an `https://open.spotify.com/` link (optionally with an `intl-<locale>/` segment and a query string) of kind `track`, `album`, `playlist`, `episode` or `show`. Artist URIs and links SHALL be refused with an error saying to play the artist's tracks, an album or a playlist instead. Any other URI SHALL be refused, naming it. All URIs SHALL be checked before any change is made.

The speakers used SHALL become exactly one Sonos group:
- with one speaker, it SHALL first leave its group if it is grouped with others;
- with several, the leader SHALL be the first home-theatre speaker (Arc, Arc Ultra, Beam, Ray, Playbar, Playbase or Amp) among them, else the first one used. Speakers in the leader's group that are not used SHALL leave it, and the other used speakers SHALL join it.

Playback SHALL then start on the leader with the first URI replacing its queue, and each further URI SHALL be added to the queue in order. The result SHALL be `{ playing: <speaker names>, leader: <name>, queued: <number of URIs queued> }` with scheduling `SILENT`. If grouping or the first URI fails, the call SHALL fail. If a later URI fails to be added, the result SHALL still report playback, with `queued` counting only the URIs that were queued and a `warning` naming each one that failed with Home Assistant's error for it, with scheduling `WHEN_IDLE`. Starting and queueing a URI SHALL be allowed longer than other Home Assistant requests (over 30 seconds), since Home Assistant may take that long to queue a long playlist.

#### Scenario: One speaker
- **WHEN** called with `speakers: ["Bedroom"]` and `uris: ["spotify:album:abc"]`, and the Playbar is not grouped
- **THEN** the album replaces the Playbar's queue and plays, no grouping service is called, and the result is `{ playing: ["[Bedroom] Sonos Playbar"], leader: "[Bedroom] Sonos Playbar", queued: 1 }` with scheduling `SILENT`

#### Scenario: Home theatre leads
- **WHEN** called with `speakers: ["Hobby Room", "Living Room"]`, the One SL being in the Hobby Room and the Arc in the Living Room
- **THEN** the One SL joins the Arc's group, playback starts on the Arc, and `leader` is the Arc's name

#### Scenario: Unnamed speaker leaves the group
- **WHEN** the Arc leads a group with the Playbar, and `sonos_play` is called for the Arc and the One SL
- **THEN** the Playbar leaves the group, the One SL joins the Arc, and playback starts on the Arc

#### Scenario: Grouped speaker plays alone
- **WHEN** the One SL is a member of the Arc's group and `sonos_play` is called for the One SL only
- **THEN** the One SL leaves the group first and the music plays on the One SL alone

#### Scenario: Several URIs
- **WHEN** called with three track URIs
- **THEN** the first replaces the queue and starts playing, the other two are added after it, and `queued` is 3

#### Scenario: Share link
- **WHEN** a URI is `https://open.spotify.com/intl-nl/playlist/xyz?si=123`
- **THEN** it is accepted and passed to Home Assistant

#### Scenario: Artist URI
- **WHEN** a URI is `spotify:artist:abc`
- **THEN** the call fails, saying artists can't be played directly and to play tracks, an album or a playlist, and Home Assistant receives no service call

#### Scenario: Not a Spotify URI
- **WHEN** a URI is `https://example.com/song.mp3`
- **THEN** the call fails naming that URI, and Home Assistant receives no service call

#### Scenario: Adding a later URI fails
- **WHEN** the first URI plays and Home Assistant rejects the second
- **THEN** the result reports playback with `queued: 1` and a `warning` naming the second URI, with scheduling `WHEN_IDLE`

### Requirement: Pause, resume and stop

`sonos_pause`, `sonos_resume` and `sonos_stop` SHALL take `speakers` (required) and send pause, play or stop to the leader of each distinct group the named speakers are in, once per group. Because a Sonos group plays as one, the result SHALL list every speaker in the affected groups: `{ paused | resumed | stopped: <speaker names> }`, with scheduling `SILENT`.

#### Scenario: Pause a group member
- **WHEN** `sonos_pause` is called for the One SL, which is a member of the Arc's group
- **THEN** the pause is sent to the Arc once, and the result lists the Arc and the One SL

#### Scenario: Two speakers in one group
- **WHEN** `sonos_stop` is called for the Arc and the One SL, which are in one group
- **THEN** one stop is sent, to the Arc

#### Scenario: Resume
- **WHEN** `sonos_resume` is called for the Bedroom while the Playbar is paused
- **THEN** play is sent to the Playbar and the result is `{ resumed: ["[Bedroom] Sonos Playbar"] }`

### Requirement: sonos_set_volume

`sonos_set_volume` SHALL take `speakers` (required) and `volume` (a number from 0 to 100, rounded to a whole number), and SHALL set that volume on each named speaker individually, also when they are grouped. A volume outside 0-100 SHALL be refused before any change. The result SHALL be `{ volume, speakers: <names> }` with scheduling `SILENT`.

#### Scenario: Grouped speakers set individually
- **WHEN** called for the Arc and the One SL with `volume: 30`
- **THEN** each speaker's volume is set to 30

#### Scenario: Out of range
- **WHEN** called with `volume: 120`
- **THEN** the call fails stating the range, and Home Assistant receives no service call

### Requirement: sonos_ungroup

`sonos_ungroup` SHALL take optional `speakers`. With speakers, each named speaker that is grouped with others SHALL leave its group. Without speakers, every speaker that is a member of a group but not its leader SHALL leave it, so every speaker ends up on its own. Speakers already on their own SHALL be left alone. The result SHALL be `{ ungrouped: <names of the speakers that left a group> }` with scheduling `SILENT`, with an empty list when nothing was grouped.

#### Scenario: Ungroup everything
- **WHEN** the Arc leads a group with the One SL and the Playbar, and `sonos_ungroup` is called without speakers
- **THEN** the One SL and the Playbar leave the group, and the result lists those two

#### Scenario: Nothing grouped
- **WHEN** no speaker is grouped and `sonos_ungroup` is called
- **THEN** no service is called and the result is `{ ungrouped: [] }`

### Requirement: Home Assistant failures

Home Assistant requests SHALL time out rather than hang. A non-OK response SHALL fail the call with an error that names the request (the service, or the speaker lookup) and the status. A failure before playback or a grouping change starts SHALL leave the speakers as they were.

#### Scenario: Home Assistant unreachable
- **WHEN** Home Assistant does not answer the speaker lookup within the timeout
- **THEN** the call fails with an error naming the speaker lookup, and the error does not contain the token

#### Scenario: Service call rejected
- **WHEN** `media_player.join` returns status 500
- **THEN** the call fails with an error naming `media_player.join` and status 500, and no playback is started
