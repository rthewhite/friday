# Spec Delta

## MODIFIED Requirements

### Requirement: Session connects to a configured Friday server

The device SHALL connect to a WebSocket server address set in the device configuration:
- **Scheme:** either `wss://` or `ws://`. Over `wss://` it SHALL verify the server certificate against the bundled public certificate authorities. `ws://` is for development on a trusted network, where the key travels unencrypted.
- **Device id:** included as the `device` query parameter. The id SHALL default to the device's node name (including any MAC suffix ESPHome adds) when the configuration sets none.
- **Key:** the device key SHALL be sent in an `Authorization: Bearer <key>` header, never in the URL.

#### Scenario: Connect URL
- **WHEN** a session starts
- **THEN** the device opens a WebSocket to `<configured base url>/ws/audio?device=<device id>` with its key in the `Authorization` header

#### Scenario: Default device id
- **WHEN** the configuration sets no device id and the node is named `friday-voice`
- **THEN** the device connects with `device=friday-voice`

#### Scenario: TLS
- **WHEN** the configured url starts with `wss://` and the server presents a valid public certificate
- **THEN** the connection is established over TLS

#### Scenario: Untrusted certificate
- **WHEN** the configured url starts with `wss://` and the server's certificate cannot be verified
- **THEN** the device does not send its key, enters the error state and returns to idle

#### Scenario: Server unreachable
- **WHEN** the connection cannot be established within a bounded time
- **THEN** the device enters the error state and returns to idle without retrying

#### Scenario: Awaiting approval
- **WHEN** the server closes the socket with code `4403`
- **THEN** the device stops the microphone, plays nothing, enters the pending state, and returns to idle after a short delay

#### Scenario: Server rejects the connection
- **WHEN** the server closes the socket during or right after the handshake with any other code, or without a code
- **THEN** the device enters the error state and returns to idle

### Requirement: Session state is exposed to the device configuration

The device SHALL expose its session state (idle, connecting, listening, speaking, pending, error) to the ESPHome configuration through a trigger so LED behaviour can be defined in YAML, and SHALL expose start, stop and toggle actions.

#### Scenario: State change
- **WHEN** the session state changes
- **THEN** the configured on-state automation runs with the new state

#### Scenario: LED feedback
- **WHEN** the device is connecting, listening, speaking, pending, or in error
- **THEN** the LED ring shows a distinct pattern for each state and is off when idle

#### Scenario: Error state is transient
- **WHEN** the device enters the error state
- **THEN** it returns to idle automatically after a short delay

#### Scenario: Pending state is transient
- **WHEN** the device enters the pending state
- **THEN** it returns to idle automatically after a short delay

### Requirement: Wake word is ignored during a session

While the device is connecting, listening, speaking, or showing the pending or error state, the wake word SHALL NOT start, restart, or otherwise affect the session.

#### Scenario: Wake word during a reply
- **WHEN** Friday is speaking and the wake word is spoken
- **THEN** the session continues unchanged

#### Scenario: Wake word while connecting
- **WHEN** the device is connecting and the wake word is spoken again
- **THEN** only one session is started

#### Scenario: Wake word after the session ends
- **WHEN** a session has ended and the device is idle again
- **THEN** the wake word starts a new session

## ADDED Requirements

### Requirement: The device generates and keeps its own key

On its first start without a stored key, the device SHALL generate a key from 32 bytes of the hardware random number generator, encoded as unpadded base64url, and SHALL write it to non-volatile storage immediately. It SHALL reuse that key on every later start. The key SHALL survive power loss, restarts, OTA updates and reflashes that do not erase the flash. A factory reset or full flash erase SHALL make the device generate a new key on its next start. The key SHALL NOT be printed in logs or exposed to Home Assistant.

#### Scenario: Power cut
- **WHEN** the device loses power and starts again
- **THEN** it connects with the same key and the same fingerprint as before

#### Scenario: Power cut right after first boot
- **WHEN** the device loses power seconds after generating its key
- **THEN** it starts with that same key afterwards

#### Scenario: OTA update
- **WHEN** new firmware is installed over the air
- **THEN** the key is unchanged

#### Scenario: Factory reset
- **WHEN** the device is factory reset
- **THEN** it starts with a new key, and Friday sees it as a device presenting a different key

### Requirement: The device shows its key fingerprint

The device SHALL compute its key's fingerprint as specified in `voice-devices`, log it at startup and in its configuration dump, and expose it to the device configuration so it can be shown as a Home Assistant sensor. The fingerprint SHALL match the one the portal shows for that key.

#### Scenario: Compare before accepting
- **WHEN** the user looks up the device's fingerprint sensor in Home Assistant and the pending attempt in the portal
- **THEN** both show the same value
