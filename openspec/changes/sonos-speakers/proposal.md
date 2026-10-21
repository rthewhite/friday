# Proposal

## Why

Jarvis could play music on the house's Sonos speakers, group them for multi-room playback and set their volume. Friday can't, and it is replacing Jarvis. Jarvis did this with its own pod on the host network, finding speakers by SSDP multicast, which doesn't reach Friday's pod. Home Assistant already runs the Sonos integration with every speaker as a `media_player` entity in its area, and Friday already talks to Home Assistant for the Apple TV. Porting the tools on top of Home Assistant gives the same capabilities without network discovery, and the HA areas line up with the voice devices' areas.

## What Changes

- New in-process module `sonos` (`modules/sonos`, `@friday/module-sonos`) that controls Sonos speakers through Home Assistant's REST API. It requires `HA_URL` and `HA_TOKEN`, the same keys the `media` module uses, so a global value serves both.
- Speakers are the `media_player` entities of HA's `sonos` integration, read fresh on every call with one template request (entity, name, area, model, state, group, volume, what's playing). There is no background scan or cache. Other media players, including HA group entities such as `media_player.all_speakers`, are not speakers.
- A speaker can be named by its HA area ("Bedroom"), its name or its entity id. That lets the model use the voice device's own area for "play this here".
- Tools on voice and chat, ported from Jarvis's Sonos tool:
  - `sonos_list_speakers`
  - `sonos_play` (speakers, Spotify URIs or links): the named speakers become one group, led by a home-theatre speaker when one is named. The first URI replaces the queue and the rest are added.
  - `sonos_pause`, `sonos_resume`, `sonos_stop`: sent to the group leaders.
  - `sonos_set_volume` (0-100): set per speaker.
  - `sonos_ungroup`: the named speakers, or every grouped speaker.
- Spotify artist URIs and links are refused with a message saying what can be played instead. Jarvis rewrote them to an `artistTopTracks` URI, which Home Assistant's Sonos integration is not known to accept. This is unverified until the device test.
- Not ported: Jarvis's `refresh-sonos-speakers` (nothing is cached) and `search-and-play-on-sonos`. Spotify search is ported separately, in parallel, as its own module. The model chains its search tool into `sonos_play`, so a Spotify module can pass an artist's tracks as `uris`.

Out of scope: Sonos favourites and radio (`select_source`), next/previous track, the speakers in the prompt context, announcements over playing music, and ducking music when an alert rings.

## Capabilities

### New Capabilities

- `sonos`: the `sonos` module, speaker resolution through Home Assistant, and the playback, grouping and volume tools.

### Modified Capabilities

None. The module uses the existing module, tool and configuration contracts unchanged.

## Impact

- New `modules/sonos` (index, a Home Assistant client with a template call, speaker resolution, tools) with tests against a fake Home Assistant.
- `packages/core/src/modules.ts` and `packages/core/package.json`: register the module. `pnpm-lock.yaml`.
- Docs: README (modules table, overview, a Sonos section), `.env.example` (HA keys now shared by `media` and `sonos`), the `deploy/k8s.yaml` secret comment, `openspec/config.yaml` context.
- No migration, no new environment variables, no new dependencies.
- Runs alongside the Spotify port and the `agents` change. Both add to the same lists (`modules.ts`, README, `.env.example`, `openspec/config.yaml`), so conflicts are mechanical. Whichever merges second rebases.
- Needs a device test at home (track, album, playlist and artist URIs on the Arc; grouping the Arc with the One SL) before archiving.
