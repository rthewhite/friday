# Design

## Context

Jarvis's Sonos tool (`~/Projects/jarvis/tools/sonos/src/index.ts`) talked to the speakers directly with the `sonos` npm package: SSDP discovery every 30 s into an in-memory cache, zone topology for speaker types and leader addresses, a manual queue sequence for albums and playlists, and Spotify search with an OAuth token. Friday's pod has no `hostNetwork`, so SSDP doesn't reach it. Home Assistant already runs the Sonos integration. In the household's HA (checked read-only on 2026-10-21) it has `media_player.sonos_arc` (Living Room, Arc), `media_player.bedroom_sonos_playbar` (Bedroom, Playbar) and `media_player.sonos_one_sl` (Hobby Room, One SL), all with grouping, enqueue and announce support. Next to them are `media_player.all_speakers` (an HA group entity) and `media_player.office_sonos` (unavailable, not in the `sonos` integration).

`modules/media/src/ha.ts` is a 35-line REST client (`call`, `state`) with timeouts. Tool handlers that throw become `{ error }` with scheduling `INTERRUPT` in the registry, so tools only need to return their success shape.

## Goals / Non-Goals

**Goals:**
- Jarvis's Sonos capabilities on Friday's existing Home Assistant connection, with no extra pod, network mode or dependency.
- Speaker references the model can derive from the device's own area.
- A `sonos_play` contract the parallel Spotify port can target: Spotify URIs or links, several at once.

**Non-Goals:**
- Talking to speakers directly (UPnP/SOAP on port 1400) or discovering them.
- Restoring a previous group when a call fails halfway through grouping.
- Anything listed as out of scope in the proposal.

## Decisions

### Home Assistant, not the speakers

All control goes through HA services: `media_player.join`/`unjoin`, `play_media`, `media_pause`/`media_play`/`media_stop` and `volume_set`. HA owns discovery, availability and the Sonos topology. The alternative was porting Jarvis's direct control with a seed IP, which works from the pod but keeps a second source of truth for speakers and loses the HA areas. The cost is HA as a dependency: if HA is down, Sonos control is down. The Apple TV path already has the same dependency.

### One template request per call for the speaker list

`POST /api/template` renders a Jinja template that returns JSON, so one request gives everything the tools need:

```jinja
[{% for e in integration_entities('sonos') | select('match', 'media_player\.') %}
  {% set d = device_id(e) %}
  {{ {"entity": e, "name": state_attr(e, 'friendly_name'), "area": area_name(e),
      "model": device_attr(d, 'model') if d else none, "state": states(e),
      "volume": state_attr(e, 'volume_level'), "group": state_attr(e, 'group_members'),
      "title": state_attr(e, 'media_title'), "artist": state_attr(e, 'media_artist')} | tojson }}
  {{ "," if not loop.last }}
{% endfor %}]
```

The REST state API has no areas or device models, and `integration_entities('sonos')` excludes group entities and other integrations for free. The template lives in one constant and is parsed defensively (non-array or malformed entries count as a failed lookup). Nothing is cached: it's one LAN request (well under a second), and a fresh read means groups and states are never stale. Jarvis needed a cache because SSDP takes 10 s. The template API needs a token that may render templates. The long-lived token Friday already uses does.

The HA client is copied from `modules/media/src/ha.ts` into `modules/sonos/src/ha.ts` and gains `template(text)`. Modules depend only on the SDK, and 40 lines don't justify a shared package. If a third HA module appears, move it into `@friday/sdk`.

### Matching speaker references

A reference is normalized to lowercase letters and digits only, then compared with the entity id (whole id, and without the `media_player.` prefix), the name, then the area. The first kind that matches anything wins, so a speaker named `Bedroom` beats the Bedroom area. An area resolves to all of its speakers. The device prompt's area is free text up to 80 characters ("Living room"), and normalization makes it match HA's "Living Room". Matching is exact after normalization, not by substring: with only a handful of speakers, a wrong substring match ("room" matching every room) is worse than an error that lists the choices.

### Group semantics of `sonos_play`

The named speakers become exactly one group (spec: sonos_play). Jarvis only joined speakers to a leader, so music could keep playing on speakers that weren't asked for, and a lone member couldn't play on its own. Sequence:

```
resolve speakers + validate URIs            (no HA writes yet)
one speaker:  grouped with others? -> unjoin it
several:      leader = first home theatre (by model) else first named
              unjoin members of leader's group that aren't named
              join leader with the other named speakers (one call)
play_media(leader, uris[0], enqueue: replace)
play_media(leader, uris[i], enqueue: add)   for i = 1..n-1, in order
```

The leader rule comes from Jarvis (home-theatre setups must lead). It is applied by model name, because HA has no speaker-type attribute. The models are Arc, Arc Ultra, Beam, Ray, Playbar, Playbase and Amp, matched case-insensitively against `model`. `media_content_type` is `music`. HA's Sonos integration turns Spotify URIs and `open.spotify.com` links into queue items itself, which replaces Jarvis's flush/queue/selectQueue/play sequence.

### Spotify artists are refused

Jarvis rewrote `spotify:artist:<id>` to `spotify:artistTopTracks:<id>` for its direct queue call. HA's share-link handling is only known to cover tracks, albums, playlists, episodes and shows. Passing an artist through risks a silent failure or an HA error the model can't act on. Refusing gives a clear next step, and the Spotify port can pass an artist's top tracks as several `uris`. Allowing artists later is a widening of the accepted kinds, with no contract break.

### Results and scheduling

Successful actions return `SILENT`, like `play_on_apple_tv`: the music starting (or stopping) is the answer, and Gemini shouldn't talk over it. Errors throw (registry → `INTERRUPT`). A partial queue failure returns `WHEN_IDLE` with a `warning`, the same shape as `play_on_apple_tv`'s failure to mark an item watched. `sonos_list_speakers` uses the registry default. In chat, scheduling is ignored.

Parameters use Gemini's schema subset: `speakers` and `uris` are `ARRAY` of `STRING` (no unions, unlike Jarvis's `string | string[]`). `volume` is a `NUMBER`. Tool descriptions say that `speakers` takes room/area names, including the device's own area, and that `sonos_play` takes Spotify track, album, playlist, episode or show URIs or links, never artists.

### Module shape

`modules/sonos/src/`:
- `index.ts`: manifest and tool definitions
- `ha.ts`: the client
- `speakers.ts`: template, parsing, `resolve`
- `uris.ts`: validation
- `control.ts`: grouping, play, transport, volume, ungroup

`createSonosModule({ fetch })` for tests, like `media` and `travel`. Tests use a fake HA built on injectable `fetch`: the template endpoint returns fixture speakers, and every service call is recorded and checked for order and payload.

## Risks / Trade-offs

- [Unverified HA behaviour with real speakers: share links via `play_media`, `enqueue: add` after `replace`, `join` with a home theatre as leader] → a device-test task at home before archiving. Specs that turn out wrong get fixed in this change before archive.
- [`join` returns before Sonos has regrouped, so `play_media` on the leader hits a stale topology] → HA's Sonos `join` waits for the topology update. If the device test shows otherwise, re-read the speaker list until the group matches (bounded, about 5 s) before playing.
- [Partial grouping on failure: unjoin succeeded, join failed] → the error names the failed service. The user can retry or ungroup. Restoring the old group is a non-goal.
- [The template API is unavailable in a locked-down HA] → the lookup error names it. This HA renders templates today.
- [HA down → no Sonos] → same as the Apple TV path. The error says HA failed.
- [Home-theatre detection by model name misses future models] → the list sits in one constant. A missed model only changes which speaker leads.

## Migration Plan

New module, no data. Deploy as usual. The module loads when `HA_URL`/`HA_TOKEN` are set, which they already are for `media`. Leave it out with `FRIDAY_MODULES` to roll back. Jarvis's Sonos pod is unaffected and can be retired separately.

## Open Questions

- Do Sonos `episode`/`show` (podcast) links play through HA's Sonos integration? They're accepted per spec, and the device test checks them if time allows.
