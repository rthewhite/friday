# Proposal

## Why

Friday has one voice satellite today, and a second one (a ReSpeaker XVF3800) is on its way. Right now anything on the LAN can open `/ws/audio?device=<anything>`, the device id is a label the client makes up, and Friday has no idea where a satellite is. So "turn on the lights" can't default to the room you're standing in. Adding satellites should come down to flash, wake and accept, and each satellite should tell Friday which room it's in.

## What Changes

- **New device registry** in `friday.db`. Each voice device has an id, a label, a Home Assistant area, notes for Friday, the hash of its key, creation and last-seen times, and a revoked flag.
- **Trust on first use.** The device generates its own random key on first boot and keeps it in flash, so it survives power loss, OTA updates and reflashes. When a device with an unknown id (or a known id with a new key) connects, Friday rejects it with `4403 pending approval` and records the attempt with a short key fingerprint. Accepting it in the portal stores that key, and the next connection works.
- **Device connections must authenticate. BREAKING for the current Voice PE firmware.** A connection to `/ws/audio` that carries `?device=` must send `Authorization: Bearer <key>` matching that registered, non-revoked device. Otherwise it is closed before a Gemini session opens. Connections without `?device=` (the portal's Talk page) work exactly as before.
- **Room context in the prompt.** A voice session from a registered device appends a device block to its system prompt: the device's label, its Home Assistant area as the default when the user names no room, and its notes. The Home Assistant MCP server's tools already take an area, so no new tool is needed.
- **Portal: Settings > Voice devices.** This page has:
  - a table of devices showing connected now or last seen, label, id, area and fingerprint,
  - pending devices with Accept (label, area, notes) and Ignore,
  - Replace key for a known device that came back with a new key,
  - editing of label, area and notes,
  - Revoke, which closes an open session, and Delete.
  The Conversations page shows the device's label instead of its raw id.
- **Firmware (`friday_client`).** The component:
  - generates the key and persists it at once,
  - sends the key in the `Authorization` header,
  - connects over `wss://` with the ESP-IDF certificate bundle (`ws://` stays allowed for local development),
  - logs the key fingerprint,
  - shows a distinct `pending` state when Friday answers `4403`,
  - defaults `device_id` to the node name.
  The Voice PE YAML moves to `wss://friday.thewhite.nl/ws/audio`. **BREAKING:** the current Voice PE has to be reflashed once and accepted.
- **Deployment.** The plain-HTTP `friday-ws-plain` ingress route in `deploy/k8s.yaml` is removed. Devices use TLS on the main host.

Out of scope:
- firmware for the XVF3800 (a follow-up change, and the first device onboarded with this flow),
- portal or browser login and pairing a browser as a device,
- picking areas from Home Assistant's area list (the area is free text for now),
- passing the device to tool handlers or to module prompt providers,
- per-device settings (voice, timeouts),
- arbitration when two satellites hear the same wake word.

## Capabilities

### New Capabilities
- `voice-devices`: the device registry. It covers trust-on-first-use key approval (pending attempts, fingerprints, accept, ignore, replace key, revoke, delete), the device's metadata, connection status, `/api/devices` and the portal's Voice devices page.

### Modified Capabilities
- `audio-transport`: `?device=` connections are authenticated against the registry before a Gemini session opens, are closed with `4400` (malformed id or key), `4403` (pending) or `4401` (missing key, revoked device), and are closed when the device is revoked or deleted or its key is replaced.
- `voice-session`: the voice system prompt gains a device block after the module context when the session belongs to a registered device.
- `voice-pe-client`: the device's own persistent key, the `Authorization` header, `wss://`, the fingerprint log and a `pending` session state with its own LED pattern. The default device id is the node name.
- `portal-shell`: the System section gains `Voice devices`.
- `conversation-store`: the Conversations page shows a registered device's label (with its id on hover) instead of the raw id.

## Impact

- **Code:**
  - `packages/core/src/storage/db.ts` (migration 7: `devices`, `device_attempts`)
  - new `packages/core/src/devices/` (store and API)
  - `packages/core/src/transports/ws.ts` (authenticate before `open()`, track open sessions per device, close on revoke)
  - `packages/core/src/prompt-context.ts` (device block)
  - `packages/core/src/app.ts` and `server.ts` (wiring, `/api/devices` routes)
  - `packages/portal/src/pages/settings/VoiceDevicesPage.vue`, `router.ts`, `shell/Shell.vue`, `pages/ConversationsPage.vue`
  - `esphome/components/friday_client/*`, `esphome/friday-voice-pe.yaml`
- **Tests:** `packages/core/test/` (storage migration, device store, ws auth, device API, prompt). The firmware is checked by compiling it and by a manual run on the Voice PE.
- **Deployment and docs:**
  - `deploy/k8s.yaml` (remove `friday-ws-plain`)
  - `README.md` (Voice PE setup and onboarding, the protocol's auth)
  - `openspec/config.yaml` context
- **Configuration:** no new environment variables.
- **Rollout:** after this deploys, the current Voice PE is rejected until it is reflashed with the new firmware and accepted in the portal.
- **In flight:** none.
