# Tasks

## 1. Core: device store

- [x] 1.1 Add migration 7 `voice-devices` to `packages/core/src/storage/db.ts` with the `devices` and `device_attempts` tables (design D1). Add a case to `packages/core/test/storage.test.ts` that a database at version 6 upgrades to 7 with both tables empty and existing conversations untouched. Verify `pnpm --filter @friday/core test` and `typecheck` pass.
- [x] 1.2 Implement `DeviceStore` in `packages/core/src/devices/store.ts` (design D1, D4, D6):
  - id and key validation,
  - `authenticate(id, key)` returning the device snapshot or `{ code, reason }`, as in the audio-transport delta's table, comparing the hash with `timingSafeEqual`, updating `last_seen_at` on success, and upserting an attempt for an unknown id or a different key (never for a revoked id),
  - lazy pruning of attempts (24 hours, at most 20 rows),
  - `list()` returning devices with fingerprint and replacement, and pending attempts for unregistered ids, never with a key hash,
  - `accept`, `ignore`, `update` (label 1 to 80, area up to 80, notes up to 1000), `replaceKey`, `revoke` and `remove`, with typed not-found, conflict and input errors,
  - `fingerprint(hash)`.

  Add `packages/core/test/device-store.test.ts` covering each scenario in the voice-devices delta: key at rest, fingerprint format, first and repeated attempts, the stale attempt and the 20-row cap, no key, replacement while the old key still works, accept, accept with a stale fingerprint, ignore, replace, an edit with an over-long note refused, revoke (rejected with no attempt), and delete followed by re-onboarding. Verify the core tests and typecheck pass.
- [x] 1.3 Add `DeviceSessions` in `packages/core/src/devices/sessions.ts` (design D3): add and remove a socket per device id, `connected(id)`, and `disconnect(id)` closing each socket with `4401 unauthorized`. Add unit cases to `packages/core/test/device-store.test.ts` (or its own file) for two sockets on one id, connected status after one closes, and disconnect closing both. Verify the core tests and typecheck pass.

## 2. Core: transport, prompt and API

- [ ] 2.1 In `packages/core/src/transports/ws.ts`, authenticate `?device=` connections before creating the recorder or session (design D2):
  - read the key from `Authorization: Bearer`,
  - close with the store's code and reason, dropping any frames that arrive before the close,
  - close with `4401` when no store is wired,
  - register accepted sockets in `DeviceSessions`,
  - pass the device snapshot to `createSession`,
  - update the protocol comment at the top of the file.

  Extend `startHarness` in `packages/core/test/helpers.ts` to take a store and request headers. Update the existing `?device=` tests in `packages/core/test/ws.test.ts` to connect with a registered key. Add cases for each audio-transport delta scenario: accepted device, new device (`4403`, no session, attempt recorded), missing key, revoked device, malformed id, key in the URL, and revoking while a session is open (`4401`, session closed). Also cover a connection without `device` that still needs no key. Verify the core tests and typecheck pass.
- [ ] 2.2 Add the device block to `systemPrompt` in `packages/core/src/prompt-context.ts` (design D5), and have the default session factory in `ws.ts` pass the accepted device. Add cases to `packages/core/test/prompt-context.test.ts` for the voice-session delta's device scenarios: with area and notes, without either, no device, and the snapshot staying fixed after an edit. Add a case to `packages/core/test/ws.test.ts` checking that the session created for a registered device receives the device. Verify the core tests and typecheck pass.
- [ ] 2.3 Add the `/api/devices` routes to `packages/core/src/app.ts` (design D7):
  - list, accept, ignore, update, replace-key, revoke and delete,
  - 404, 409 and 400 mapping,
  - 503 without a store,
  - `connected` from `DeviceSessions`,
  - `disconnect` on revoke, delete and replace-key.

  Wire one `DeviceStore` and `DeviceSessions` in `packages/core/src/server.ts` into both `createApp` and `attachAudioWs`. Add `packages/core/test/devices-api.test.ts` covering the API scenarios (listing without keys or hashes, accept of an unknown id answering 404, stale fingerprint answering 409, invalid input answering 400 with the field name), plus revoke closing a live socket through the app. Verify the core tests and typecheck pass.
- [ ] 2.4 Document the change:
  - **`README.md`:** the protocol section (device auth, close codes), conversations (device labels), and a new "Voice devices" section (onboarding flow, fingerprint, replace key, revoke).
  - **`openspec/config.yaml` context:** the device registry, `/ws/audio` auth and the prompt's device block.

  Verify with `grep -n "Voice devices\|4403" README.md openspec/config.yaml` that both mention them.

## 3. Portal

- [ ] 3.1 Add `packages/portal/src/pages/settings/VoiceDevicesPage.vue` (design D7):
  - pending table with `Accept` and `Ignore`,
  - accept drawer showing id and fingerprint, with label, area (with the HA area hint) and notes,
  - devices table with status dot, label, id, area, fingerprint, last connected and a replacement marker,
  - device drawer with edit, `Replace key` showing both fingerprints, `Revoke`, and `Delete` with confirmation,
  - `Refresh` and the help text.

  Register `/settings/devices` in `router.ts` and add `Voice devices` to the System group in `shell/Shell.vue`, after `Configuration`. Verify `pnpm --filter @friday/portal typecheck` and `build` pass.
- [ ] 3.2 Show device labels on the Conversations page: add a small `packages/portal/src/lib/devices.ts` (id-to-label map and a display helper falling back to the id), load `/api/devices` once in `ConversationsPage.vue`, and show the label with the id as a `title` in the table and the drawer. Add `packages/portal/test/devices.test.ts` for the registered and unregistered cases. Verify `pnpm --filter @friday/portal test` and `typecheck` pass.
- [ ] 3.3 Start a dev server on free ports (`FRIDAY_PORT=8081 FRIDAY_CORE_URL=http://localhost:8081 pnpm dev`), then:
  1. Simulate a device with a `ws` client script that sends `?device=test-sat` and a random Bearer key.
  2. Confirm it is closed with `4403` and listed under pending with the fingerprint the script prints.
  3. Accept it with an area.
  4. Reconnect and confirm a session opens and the device shows as connected.
  5. Edit its notes, revoke it while connected (the socket closes with `4401`), and delete it.

  Stop the dev server.

## 4. Firmware and deployment

- [ ] 4.1 In `esphome/components/friday_client/` (design D8):
  - generate and persist the key (preference, `esp_fill_random`, immediate `sync()`),
  - compute the fingerprint with mbedtls, log it in `setup()` and `dump_config()`, and expose `get_key_fingerprint()`,
  - send the `Authorization` header,
  - attach the certificate bundle for `wss://`, and let `_ws_url` accept `ws://` and `wss://`,
  - default `device_id` to `App.get_name()`,
  - parse the close code, and add `State::PENDING` with `pending` in `state_name` and the idle return after `error_hold`.

  Update the component docstring. Verify `esphome compile esphome/friday-voice-pe.yaml` succeeds.
- [ ] 4.2 Update `esphome/friday-voice-pe.yaml`:
  - url `wss://${friday_host}/ws/audio` (drop `friday_port`),
  - remove `device_id`,
  - a "Pending" LED effect (slow amber pulse) in `control_leds`,
  - wake word disabled while pending as for error,
  - a diagnostic template text sensor "Friday key fingerprint".

  Update the README Voice PE section: setup, the pending LED, the fingerprint sensor, `wss://`, and the troubleshooting lines that mention `ws://` and port 8080. Verify `esphome compile esphome/friday-voice-pe.yaml` succeeds and `grep -n "ws://friday" README.md esphome/friday-voice-pe.yaml` finds nothing.
- [ ] 4.3 Remove the `friday-ws-plain` IngressRoute from `deploy/k8s.yaml` and its mention in the comments. Add the one-off `kubectl -n friday delete ingressroute friday-ws-plain` and the rollout order (design Migration Plan) to `infra/README.md`. Verify with `grep -n "friday-ws-plain" deploy/k8s.yaml` (no match) and `kubectl apply --dry-run=client -f deploy/k8s.yaml` (or a YAML parse) succeeding.

## 5. Integration

- [ ] 5.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` and verify all green.
- [ ] 5.2 On the real Voice PE against a dev server or the deployed build (with the user's go-ahead for deploying):
  1. OTA-flash the new firmware and note the fingerprint sensor in Home Assistant.
  2. Say "hey friday" and confirm the pending LED, and that the portal lists `friday-voice` with the same fingerprint.
  3. Accept it with its HA area.
  4. Ask "turn on the lights" and confirm the HA MCP call carries that area (the Conversations drawer's tool entry).
  5. Power-cycle the device and confirm it still connects without re-approval.
  6. Measure wake-to-listening time over `wss://` and record it here.
