# Spec Delta

## ADDED Requirements

### Requirement: Devices keep a control connection at /ws/device

The server SHALL accept WebSocket connections at `/ws/device?device=<id>`, authenticated exactly as device connections to `/ws/audio` are (as specified in "Device connections are authenticated before a session opens"): the same close codes, the same pending attempts, and the device's last connection time is recorded. A control connection SHALL NOT open a Gemini session and SHALL NOT carry audio. Binary frames from the device SHALL be ignored. A device SHALL have at most one control connection: when a device opens a new one, the server SHALL close the older one with `4409 replaced`. Control connections SHALL be kept alive as specified in "Connections are kept alive and dead connections are closed".

The server SHALL send these JSON text frames:
- `{"type":"ring","data":{"alert":"<id>"}}`: open an alert session for this alert (as specified in "Alert sessions are opened with an alert parameter").
- `{"type":"stop","data":{"alert":"<id>"}}`: the alert no longer needs ringing (it was acknowledged, cancelled or missed); a device ringing it locally stops.

The device MAY send these JSON text frames:
- `{"type":"ringing_locally","alert":"<id>"}`: the device rings the alert with its own tone, because it could not open an alert session for it.
- `{"type":"acknowledged","alert":"<id>"}`: the user pressed the device's button while the alert rang.
- `{"type":"unanswered","alert":"<id>"}`: the device's own tone for the alert ran out without a button press.

Frames from the device that are not one of these, or that name an alert that is not ringing on that device, SHALL be ignored without closing the connection.

#### Scenario: Device comes online
- **WHEN** registered device `friday-kitchen` connects to `/ws/device?device=friday-kitchen` with its key
- **THEN** the connection stays open, no Gemini session is opened, and the device counts as online

#### Scenario: New device at boot
- **WHEN** a freshly flashed device that is not registered opens its control connection
- **THEN** the socket is closed with `4403 pending approval` and a pending attempt is recorded, before anyone has spoken the wake word

#### Scenario: Reconnect
- **WHEN** `friday-kitchen` opens a second control connection while the first is still open
- **THEN** the first is closed with `4409 replaced` and the second stays open

#### Scenario: Ring
- **WHEN** an alert of `friday-kitchen` falls due
- **THEN** the device's control connection receives `{"type":"ring","data":{"alert":"<id>"}}`

#### Scenario: Button pressed while ringing
- **WHEN** the device sends `{"type":"acknowledged","alert":"<id>"}` for an alert that rings on it
- **THEN** the alert is acknowledged

#### Scenario: Unknown alert
- **WHEN** the device sends `acknowledged` naming an alert of another device
- **THEN** the frame is ignored and the connection stays open

### Requirement: Alert sessions are opened with an alert parameter

A device connection to `/ws/audio` MAY carry an `alert` query parameter naming an alert. After the device is authenticated, the server SHALL check that the alert is `ringing` on that device. When it is, the session SHALL open as an alert session (as specified in `voice-session`) for every alert ringing on that device. When it is not (unknown, of another device, or no longer ringing), the server SHALL close the socket with `4410 alert gone` and SHALL NOT open a Gemini session. A connection without a `device` parameter SHALL ignore `alert`.

#### Scenario: Answering a ring
- **WHEN** `friday-kitchen` connects to `/ws/audio?device=friday-kitchen&alert=<id>` with its key while that alert is ringing
- **THEN** an alert session opens for it

#### Scenario: Alert cancelled meanwhile
- **WHEN** the alert was cancelled between the `ring` and the device's connection
- **THEN** the socket is closed with `4410 alert gone` and no Gemini session is opened

#### Scenario: Gemini unavailable
- **WHEN** the device connects for a ringing alert and the Gemini session cannot be opened
- **THEN** the socket is closed with `1011 gemini unavailable`, as for any session

#### Scenario: Talk page
- **WHEN** a connection without `device` carries `alert=<id>`
- **THEN** a normal session opens and the parameter is ignored

## MODIFIED Requirements

### Requirement: Revoking or replacing a device ends its open sessions

When a device is revoked or deleted, or its key is replaced, the server SHALL close every open connection of that device with `4401 unauthorized`, its control connection included, and the Gemini session of each SHALL be closed.

#### Scenario: Revoked mid-conversation
- **WHEN** the user revokes `kitchen` while it has a session open
- **THEN** its socket is closed with `4401` and its Gemini session is closed

#### Scenario: Revoked while idle
- **WHEN** the user revokes `kitchen` while only its control connection is open
- **THEN** the control connection is closed with `4401` and the device no longer counts as online
