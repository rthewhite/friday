# Design

## Context

See proposal.md (Why) and the delta specs for the behaviour. The code as it stands:

- **`serveWs` opens Gemini first.** `serveWs` (`packages/core/src/transports/ws.ts`) reads `?device=`, creates the recorder and session, and calls `g.open()` before anything else. There is no check, and `device` is only logged and recorded. `mountWs` (`transports/mount.ts`) upgrades every request on a mounted path unconditionally.
- **The prompt is built once per session.** `systemPrompt(context, "voice")` (`prompt-context.ts`) returns a function that `GeminiSession` calls once in `open()` (`session.ts:81`). That is where a per-session prompt is fixed today.
- **Remote module keys are the precedent.**
  - `SqliteKeyStore` (`remote/key-store.ts`) stores `sha256(key)` hex in `module_keys`, looks keys up by hash and updates `last_seen_at`.
  - `/api/keys` lives in `app.ts`, and revoking calls `RemoteHost.disconnect(id)`.
  - The portal page is `pages/settings/RemoteModulesPage.vue`.
  - Remote modules are rejected *after* the upgrade, with `4401`/`4400` close codes.
- **Migrations:** the last one is 6 (`conversation-search`).
- **Firmware.**
  - `friday_client` uses `esp_websocket_client` 1.8.0 with `esp-tls` already included. `connect_()` builds the URI with `?device=`.
  - `_ws_url` in `__init__.py` refuses anything but `ws://`.
  - `WEBSOCKET_EVENT_CONNECTED` starts the microphone and enters `LISTENING`. Close frames are only logged.
  - The Voice PE YAML already sets `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC` and TLS 1.3, has PSRAM, and has a `factory_reset` button.
- **Deployment.** `deploy.yml` runs `kubectl apply` without `--prune`, so deleting the `friday-ws-plain` IngressRoute from `deploy/k8s.yaml` does not remove it from the cluster.

## Goals / Non-Goals

**Goals:**
- A rejected device costs nothing: no Gemini connection and no recorder, only a bounded write to `device_attempts`.
- The device's metadata is read once when its connection is accepted and stays fixed for that session, like the module context.
- The same fingerprint rule on both sides (core and firmware), so the user can compare without trusting either screen.

**Non-Goals:**
- Rate limiting connection attempts beyond the 20-row cap. The network is trusted (LAN/VPN only).
- Constant-time protection against id enumeration. Whether an id is registered isn't secret.
- Changing `/ws/modules` or remote module keys.

## Decisions

### D1. Two tables: `devices` and `device_attempts` (migration 7 `voice-devices`)

```
devices          id TEXT PRIMARY KEY, label TEXT NOT NULL, area TEXT, notes TEXT,
                 key_hash TEXT NOT NULL, created_at TEXT NOT NULL, key_replaced_at TEXT,
                 last_seen_at TEXT, revoked_at TEXT
device_attempts  device_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL,
                 first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, attempts INTEGER NOT NULL
```

A pending attempt and a registered device can exist for the same id at once: that's the replacement case. So an attempt is its own row, keyed by the claimed id, not a status on `devices`.
- **Fingerprint:** never stored. It is derived from `key_hash` (D4).
- **Expiry and cap:** enforced lazily, inside the write that records an attempt and inside `list`. There is no background job, so a stale row can't be listed and the table can't grow past 20 rows plus the one being written.
- **Code:** a `DeviceStore` in `packages/core/src/devices/store.ts`. Its methods are `authenticate`, `list`, `accept`, `ignore`, `update`, `replaceKey`, `revoke`, `remove` and `touch`.

*Alternative:* one table with `status: pending | active | revoked`. That breaks down on the replacement case, where an active row and a pending key exist for the same id.

### D2. Authenticate inside `serveWs`, after the upgrade, before the session is created

`serveWs` reads `device` and `req.headers.authorization` first and calls `DeviceStore.authenticate(id, key)`. That returns either `{ device }` (a snapshot of the record) or `{ code, reason }`, following the table in the audio-transport delta.
- **On rejection:** it calls `ws.close(code, reason)` and returns. No recorder or session is created, and messages that arrive before the close are dropped.
- **Lookup:** by id (the device claims one), then the stored hash is compared with `timingSafeEqual` on the hex digests. This is unlike module keys, which are looked up by hash.
- **Bad input:** the id and key rules are checked first. Malformed input never reaches the database.
- **Last seen:** success updates `last_seen_at`.

`AudioWsOptions` gains `devices?: DeviceStore` and `deviceSessions?: DeviceSessions` (D3). Without a store, every `?device=` connection is closed with `4401`. A missing dependency should fail closed, so tests that use `?device=` pass an in-memory store. `createSession` gains the accepted device as a third argument. Tests can then see which device a session belongs to, and the default factory can build the prompt.

*Alternatives:*
- *Reject during the HTTP upgrade (401/403), via a per-path check in `mountWs`.* The ESP client reports a handshake status, but browsers can't see it. It would also need a second rejection style next to `/ws/modules`'s close codes, and `mountWs` is shared. Close codes after the upgrade are consistent with remote modules and easy to test with the `ws` client.
- *A first JSON "hello" frame carrying the key, like `/ws/modules`.* That changes the audio protocol for every client and delays the first audio frame. The header is free with `esp_websocket_client`.

### D3. Open sessions per device in a small `DeviceSessions` registry

`DeviceSessions` (in `devices/`) maps each device id to its set of open sockets. `serveWs` adds a socket when its session opens and removes it on close. It exposes `connected(id)` for the listing and `disconnect(id)`, which calls `close(4401, "unauthorized")` on each socket, for revoke, delete and replace-key. The existing close handler then closes the Gemini session. `server.ts` creates one instance and passes it to both `attachAudioWs` and `createApp`, the same way `RemoteHost.disconnect` serves `/api/keys`.

### D4. Fingerprint = first 8 hex characters of SHA-256, grouped `xxxx-xxxx`

Core derives it from the stored hex hash. The firmware computes SHA-256 of the same key string with mbedtls. 32 bits is plenty for "is this the device I just flashed?" on a home network. The fingerprint is not used to authenticate anything.

### D5. Device block appended in `systemPrompt`, from the accepted snapshot

`systemPrompt(context, channel, device?)` composes base, module context, then `deviceBlock(device)` when a device is given. It still returns a function, called once in `open()`, so the voice-session rule "fixed for the session" holds as it does today. The device is the snapshot `authenticate` returned, so an edit made during a session applies to the next one. Wording (exact text settled in implementation and covered by tests):

```
## Where you are
You are speaking through the voice device "<label>". The user is in the Home Assistant
area "<area>". When a request names no room, area or floor (for example "turn on the
lights"), use the area "<area>".
<notes>
```

The area sentences are left out when the device has no area, and the notes when it has none. The block is not counted against `FRIDAY_PROMPT_CONTEXT_MAX_CHARS`. That cap is per module, and the block is already bounded by the field limits (80 + 80 + 1000 characters). Notes come from the portal, which is the household's own admin surface, so they go in verbatim, like brain pages.

*Alternative:* pass `{ channel, device }` to module prompt providers. That widens the SDK contract with no consumer today, because lights run through the HA MCP server and not a module. A later change can add it if a module needs the device.

### D6. Accept and replace carry the fingerprint the user saw

An attempt's key can change between listing and clicking, since the same id is upserted. Accept and replace therefore carry the fingerprint, and the store compares it with the attempt's current hash inside the same transaction that moves the hash to `devices`. A mismatch answers 409, so the user never approves a key they didn't see.

### D7. API in `app.ts`, page modelled on Remote modules

The `/api/devices` routes go next to `/api/keys` in `app.ts`, and answer 503 when no store is wired, as the key routes do. Inputs are validated in the store and surfaced as 400 with the field name (the pattern of `McpInputError`).

The page `pages/settings/VoiceDevicesPage.vue` reuses `PageLayout`, `DataTable`, `StatusDot`, `Chip` and `Drawer`, with two tables (pending above devices when there are attempts). The Conversations page loads `/api/devices` once and maps ids to labels. A failure there falls back to showing ids.

### D8. Firmware: key in NVS, header, `wss://`, close code

- **Key.** In `setup()`, load a preference (`global_preferences->make_preference<KeyBlob>(fnv1_hash("friday_client.key"), true)`) holding a version byte and 32 bytes.
  - If there is none, fill it with `esp_fill_random`, `save()` it, and call `global_preferences->sync()` at once. Without the explicit sync, ESPHome writes on its flush interval, and a power cut in the first minute would lose the key.
  - The preference id is a constant, so renaming the node keeps the key.
  - The component runs at `AFTER_WIFI` priority, so the radio is on and `esp_fill_random` draws from the hardware RNG.
  - The key is encoded as unpadded base64url (43 characters).
  - ESPHome keeps preferences in NVS. NVS survives OTA and normal reflashes and is wiped by `factory_reset`, which is the behaviour the spec asks for.
- **Fingerprint.** Computed once with mbedtls SHA-256 and logged in `setup()` and `dump_config()`. It is exposed as `get_key_fingerprint()`, and the Voice PE YAML adds a template text sensor "Friday key fingerprint" (diagnostic).
- **Connect.**
  - `cfg.headers = "Authorization: Bearer <key>\r\n"`.
  - `cfg.crt_bundle_attach = esp_crt_bundle_attach` when the URI starts with `wss://`.
  - `_ws_url` accepts `ws://` and `wss://`.
  - `device_id` defaults to `App.get_name()` when unset, and the Voice PE YAML drops its `device_id: ${name}` line. The value stays `friday-voice`, so earlier conversations keep matching.
- **Pending.**
  - On a `WS_OP_CLOSE` data event, read the 2-byte big-endian close code into `close_code_`.
  - When the disconnect follows and the code is 4403, call a new `pending_()`: stop the microphone, flush the speaker, tear down, and enter `State::PENDING`. `loop()` returns to idle after `error_hold`, as it does for error. Every other unexpected close keeps the error path.
  - `state_name` gains `pending`. The YAML's `control_leds` script gets a "Pending" effect (slow amber pulse) and treats `pending` like `error` for the wake word.
- The brief `LISTENING` between the upgrade and the `4403` close, a few milliseconds, is accepted. Delaying the microphone until the server confirms would need a new "ready" event in the protocol.

*Alternative:* generate the key at build time in `secrets.yaml`. That was rejected in exploration because it puts a secret per device in the YAML, and one YAML can't serve several devices.

### D9. Ingress: remove `friday-ws-plain`, delete it by hand once

The route is removed from `deploy/k8s.yaml`. Because the deploy doesn't prune, the migration plan includes a one-off `kubectl -n friday delete ingressroute friday-ws-plain`. The README's Voice PE section and the deploy notes switch to `wss://friday.thewhite.nl/ws/audio`.

## Risks / Trade-offs

- [The TLS handshake on the ESP32-S3 adds latency between the wake word and the first audio] → The chime already covers the connect. The manual check measures wake-to-listening. `ws://` stays supported in the component if TLS turns out too slow, although the plain ingress route is gone.
- [The certificate bundle isn't in the IDF build ESPHome generates] → It's on by default in ESP-IDF (`CONFIG_MBEDTLS_CERTIFICATE_BUNDLE`). The firmware task compiles and connects against the real host. If it's missing, set it in `sdkconfig_options`.
- [Anyone on the LAN can fill the pending list with fake ids] → It's capped at 20 rows and expires after 24 hours, and accepting needs the user's click and a matching fingerprint. Spoofing doesn't lead anywhere.
- [Someone on the LAN connects as an id before the real device] → The fingerprint is shown in Home Assistant and in the portal. The user compares them, or at worst accepts the wrong key and the real device then shows up as a replacement.
- [A key over `ws://` in development is readable on the network] → It's documented as development-only. Production uses `wss://`.
- [After the deploy the current Voice PE is rejected until it is reflashed] → One device, flashed over OTA from Home Assistant or `esphome run`. The migration plan orders the steps.

## Migration Plan

1. Merge and push (this deploys). The old firmware connects over `ws://` to the plain route. It now gets `4401` (no key), or fails once the route is deleted, and shows the red error.
2. Delete the old route: `kubectl -n friday delete ingressroute friday-ws-plain`.
3. Flash the new firmware to the Voice PE over OTA (`esphome run esphome/friday-voice-pe.yaml`). It generates its key and logs the fingerprint.
4. Say "hey friday". The LED shows pending, and `friday-voice` appears under Settings > Voice devices > Pending.
5. Accept it with label, area (the HA area name) and notes. Say "hey friday" again and ask to turn on the lights. Friday should use the device's area.

Rollback:
- **Server:** reverting the server is safe with the new firmware. The old server ignores the `Authorization` header and serves `wss://` on the main ingress.
- **Firmware:** reverting the firmware needs the plain route re-applied (`kubectl apply` of the old manifest).
- **Data:** the new tables are left in place, unused.
