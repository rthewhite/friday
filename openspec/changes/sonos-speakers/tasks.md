# Tasks

## 1. Module scaffold

- [x] 1.1 Create `modules/sonos` (`@friday/module-sonos`: package.json with build/typecheck/test scripts like `modules/travel`, tsconfig, `src/index.ts` with `createSonosModule({ fetch })` and the manifest: id `sonos`, label `Sonos`, required `HA_URL` and secret `HA_TOKEN`), and register it in `packages/core/src/modules.ts` and `packages/core/package.json`. Verify with `modules/sonos/test/module.test.ts`: the module fails naming `HA_URL, HA_TOKEN` when unset; then `pnpm install` and `pnpm --filter @friday/module-sonos typecheck` and `pnpm --filter @friday/core typecheck` pass

## 2. Home Assistant client and speakers

- [x] 2.1 Add `src/ha.ts` (copied from `modules/media/src/ha.ts`, config read per call, timeouts) with `template(text)` posting to `/api/template`, and an error naming the request and status that never contains the token. Verify with `modules/sonos/test/ha.test.ts` against a fake `fetch`: bearer header, URL without a trailing slash, service-call and template errors name the request and status and don't contain the token, a hanging request times out
- [x] 2.2 Add `src/speakers.ts`: the template from design.md, defensive parsing into speakers (`name`, `area`, `model`, `entity`, `state`, `volume` 0-100, `group` by name with the leader first, title/artist), and `resolve(refs)` (normalized entity id, then name, then area; an area gives all its speakers; dedupe in first-referenced order; unknown reference error listing speakers and areas; unavailable refused). Add `test/fake-ha.ts` (fixture speakers mirroring the household: Arc/Living Room, Playbar/Bedroom, One SL/Hobby Room; recorded service calls). Verify with `modules/sonos/test/speakers.test.ts`: every scenario under "Speakers come from Home Assistant" and "Naming speakers", plus a malformed template response failing as a lookup error
- [x] 2.3 Define `sonos_list_speakers` returning `{ speakers }` with `playing` for playing/paused speakers with a title. Verify with `modules/sonos/test/tools.test.ts` (via `createTestHost`): the Karma Police scenario, an empty integration, and that the tool is offered on voice and chat

## 3. Playback and grouping

- [x] 3.1 Add `src/uris.ts`: accept `spotify:<kind>:<id>` and `https://open.spotify.com/[intl-xx/]<kind>/<id>[?...]` for track/album/playlist/episode/show; refuse artists with the "tracks, an album or a playlist" message; refuse anything else naming it; 1 to 50 URIs. Verify with `modules/sonos/test/uris.test.ts`: each kind as URI and link, the `intl-nl` link with `?si=`, artist URI and link, `https://example.com/song.mp3`, an empty list and 51 URIs
- [x] 3.2 Add the grouping and play sequence in `src/control.ts` (validate everything first; one speaker leaves its group; several: home-theatre leader by model, unjoin unnamed members of the leader's group, one `media_player.join`; `play_media` with `media_content_type: music`, `enqueue: replace` then `add` in order) and define `sonos_play` (`SILENT`; `WHEN_IDLE` with `warning` and a reduced `queued` when a later URI fails). Verify with `modules/sonos/test/play.test.ts` against the fake HA's recorded calls: every `sonos_play` scenario in the spec (one speaker, home theatre leads, unnamed speaker leaves, grouped speaker plays alone, several URIs, share link, artist, not Spotify, later URI fails), plus a failing `join` that starts no playback

## 4. Transport, volume and ungroup

- [x] 4.1 Define `sonos_pause`, `sonos_resume` and `sonos_stop`: one `media_pause`/`media_play`/`media_stop` per distinct group leader; the result lists every speaker in the affected groups; `SILENT`. Verify with `modules/sonos/test/transport.test.ts`: the pause-a-member, two-speakers-one-group and resume scenarios
- [x] 4.2 Define `sonos_set_volume` (`volume_set` per speaker with `volume_level` = volume/100, rounded, 0-100 checked first) and `sonos_ungroup` (named grouped speakers, or every non-leader member; nothing to do gives `{ ungrouped: [] }` with no service call). Verify with `modules/sonos/test/volume-ungroup.test.ts`: the grouped-volume, out-of-range, ungroup-everything and nothing-grouped scenarios, plus ungrouping one named member
- [x] 4.3 Write the tool descriptions (speakers take room/area names including the device's own area; Spotify kinds accepted, never artists; pause/stop act on the whole group; volume is per speaker). Verify with `modules/sonos/test/tools.test.ts`: the module registers exactly the seven tools in spec order, and the `sonos_play` description mentions artists not being accepted

## 5. Docs and context

- [ ] 5.1 Update the README (overview diagram line, modules table row, a "Sonos (via Home Assistant)" section: what it does, that it uses the HA Sonos integration and its areas, HA keys shared with `media`, artists refused, `FRIDAY_MODULES` to leave it out), `.env.example` (the HA keys' comment names `media` and `sonos`), the `deploy/k8s.yaml` secret comment, and the integrations part of `openspec/config.yaml` context (modules/sonos, template lookup, reference matching, the group rule, SILENT results). Verify by reading the diff and running `pnpm --filter @friday/core test` (it checks `.env.example`)

## 6. Integration

- [ ] 6.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree. Verify it is green
- [ ] 6.2 With a dev server on a free port, call `sonos_list_speakers` from portal chat against the real Home Assistant. Verify the Arc, Playbar and One SL are listed with their areas and models, and `all_speakers` and `office_sonos` are not
- [ ] 6.3 Device test at home (after merge is fine, before archive): from chat, play a track, an album, a playlist and an `open.spotify.com` link on the Arc; play on "Living Room" and "Hobby Room" together; pause, resume and set volume; ungroup. Verify each by ear and in `sonos_list_speakers`, and that the Arc led the group. If HA behaves differently from the design (share links, `enqueue: add`, join timing), fix the code and specs in this change before archiving
