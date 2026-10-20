# Spec Delta

## MODIFIED Requirements

### Requirement: Devices can be revoked and deleted

The user SHALL be able to revoke a registered device. A revoked device SHALL keep its record and SHALL be rejected on every connection, whichever key it presents, without recording a pending attempt. The user SHALL be able to delete a device, revoked or not, which removes its record; a later connection from that id SHALL be recorded as pending. Revoking or deleting SHALL close the device's open session and its control connection. Deleting SHALL cancel the device's scheduled and ringing alerts (as specified in `alerts`). Conversations recorded with the device's id SHALL keep that id.

#### Scenario: Revoke
- **WHEN** the user revokes `friday-kitchen`
- **THEN** its open session and control connection are closed, it is listed as revoked, and later connections from it are rejected and do not appear as pending

#### Scenario: Delete and onboard again
- **WHEN** the user deletes revoked `friday-kitchen` and the device connects again
- **THEN** it appears as a pending attempt

#### Scenario: Delete with a timer running
- **WHEN** the user deletes `friday-kitchen` while it has a scheduled timer
- **THEN** the timer is cancelled

### Requirement: Device status shows whether it is connected

Each registered device SHALL report whether it is online, whether it currently has an open session, and the time it last connected successfully. A device SHALL count as online while its control connection (as specified in `audio-transport`) is open. A device may hold more than one open session (for example, during a reconnect). It SHALL count as in a session while any of them is open. A device with firmware that has no control connection SHALL count as offline, even while it has a session open.

#### Scenario: Idle and online
- **WHEN** `friday-kitchen` has its control connection open and no session
- **THEN** it is listed as online and not in a session

#### Scenario: Session open
- **WHEN** `friday-kitchen` has an open session
- **THEN** it is listed as in a session, and its last-connected time is the time that session was accepted

#### Scenario: Session closed
- **WHEN** that session closes
- **THEN** it is listed as not in a session, with the same last-connected time

#### Scenario: Unplugged
- **WHEN** `friday-kitchen` loses power
- **THEN** within two keepalive intervals it is listed as offline

### Requirement: Devices API

Core SHALL serve:
- `GET /api/devices`: `{ devices, pending }`.
  - Each device: `id`, `label`, `area`, `notes`, `fingerprint`, `createdAt`, `keyReplacedAt`, `lastSeenAt`, `revoked`, `online`, `connected` (in a session), and `replacement` (`{ fingerprint, lastSeenAt, attempts }`) when one is pending.
  - Each pending attempt for an unregistered id: `id`, `fingerprint`, `firstSeenAt`, `lastSeenAt`, `attempts`.
- `POST /api/devices/pending/:id/accept` with `{ fingerprint, label?, area?, notes? }`: answers 201 with the device.
- `DELETE /api/devices/pending/:id`: ignore.
- `PUT /api/devices/:id` with `{ label?, area?, notes? }`.
- `POST /api/devices/:id/replace-key` with `{ fingerprint }`.
- `POST /api/devices/:id/revoke`.
- `DELETE /api/devices/:id`.

Errors:
- 404 for an unknown device or attempt.
- 409 when a fingerprint does not match the attempt's current key, or when accepting an id that is already registered.
- 400 with an error naming the field for invalid input.

No response SHALL contain a key or a key hash.

#### Scenario: Listing
- **WHEN** one device is registered and one unknown device has attempted to connect
- **THEN** `GET /api/devices` returns the device with its fingerprint and status, and the attempt under `pending`, and neither carries a key or hash

#### Scenario: Online flag
- **WHEN** a registered device has its control connection open and no session
- **THEN** `GET /api/devices` returns it with `online: true` and `connected: false`

#### Scenario: Accept an unknown id
- **WHEN** `POST /api/devices/pending/nope/accept` is called and no attempt exists for `nope`
- **THEN** the response is 404

#### Scenario: Stale fingerprint
- **WHEN** `POST /api/devices/friday-voice/replace-key` carries a fingerprint other than the pending replacement's
- **THEN** the response is 409 and the stored key is unchanged

### Requirement: Voice devices page

The portal SHALL provide `Settings > Voice devices` at `/settings/devices`:
- **Devices table:** one row per registered device with a status dot (in a session, online, offline, revoked), label, id, area, fingerprint and last connected time. A device with a pending replacement is marked in its row.
- **Pending section:** shown when any pending attempts exist, one row per attempt with id, fingerprint, first and last seen, attempt count, and `Accept` and `Ignore` actions.
- **Accept:** opens a drawer showing the id and fingerprint, with label, area and notes fields. The area field explains that it should be the Home Assistant area name or one of its aliases.
- **Clicking a device:** opens a drawer to edit label, area and notes, with `Replace key` when a replacement is pending (showing both fingerprints), `Revoke` for an active device, and `Delete` with confirmation.
- **Refresh:** a `Refresh` header action reloads the page.
- **Help text:** explains that a new device appears under pending after its first attempt to connect, and that a device shown as offline while idle cannot ring timers.

#### Scenario: Onboard a device
- **WHEN** a newly flashed device has tried to connect and the user opens the page
- **THEN** it is listed under pending with its fingerprint, and accepting it in the drawer moves it to the devices table

#### Scenario: Replacement pending
- **WHEN** a registered device came back with a new key
- **THEN** its row is marked and its drawer offers `Replace key` with the old and new fingerprints

#### Scenario: Old firmware
- **WHEN** a registered device runs firmware without a control connection and is idle
- **THEN** its row shows it as offline
