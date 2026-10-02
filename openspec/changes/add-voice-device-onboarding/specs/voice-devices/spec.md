# Spec Delta

## Purpose

Keeps a registry of the voice satellites allowed to talk to Friday. A satellite is onboarded by trust on first use: it presents a key it generated itself, and Friday rejects it until the user accepts it in the portal. Each device carries the room and notes Friday uses as context.

## ADDED Requirements

### Requirement: Devices are registered with a hashed key and metadata

Core SHALL store each registered voice device in `friday.db` with:
- an id,
- a label,
- an optional Home Assistant area,
- optional notes for Friday,
- the SHA-256 hash of its key,
- the time it was accepted, the time its key was last replaced, the time it last connected successfully,
- the time it was revoked, when it was.

Core SHALL NOT store a device key in plaintext.

- **Id:** 1 to 63 characters of lowercase letters, digits and hyphens, starting with a letter or digit.
- **Key:** 32 to 128 characters of `A-Z`, `a-z`, `0-9`, `-` and `_`.
- **Fingerprint:** a key's fingerprint is the first 8 hexadecimal characters of its SHA-256 hash, shown as two groups of four separated by a hyphen (for example `3f9a-c21e`).

#### Scenario: Key at rest
- **WHEN** a device is accepted
- **THEN** `friday.db` holds the hash of its key and not the key itself

#### Scenario: Fingerprint
- **WHEN** the SHA-256 hash of a device's key starts with `3f9ac21e`
- **THEN** the device's fingerprint is `3f9a-c21e`

### Requirement: Unknown connection attempts are recorded as pending

When a connection presents a well-formed device id and key, and the id is not registered, core SHALL record a pending attempt for that id. The attempt holds the key's hash, its fingerprint, when the id was first and last seen, and how many attempts were made. Core SHALL keep at most one pending attempt per id: a later attempt with the same id SHALL update it. When the key differs, the attempt SHALL take the new key and start over: its first-seen time becomes the time of that attempt and its count becomes 1. A pending attempt SHALL be removed 24 hours after its last attempt. When more than 20 pending attempts exist, the ones last seen longest ago SHALL be removed until 20 remain. A connection with a malformed id or key, or without a key, SHALL NOT record an attempt.

#### Scenario: First connection of a new device
- **WHEN** a device `friday-kitchen` that is not registered connects with a valid key
- **THEN** a pending attempt for `friday-kitchen` with that key's fingerprint is listed, with an attempt count of 1

#### Scenario: Repeated attempts
- **WHEN** the same unregistered device connects three times with the same key
- **THEN** one pending attempt is listed, with an attempt count of 3 and the time of the last attempt

#### Scenario: Another key for the same id
- **WHEN** unregistered `friday-kitchen` made 3 attempts with one key, and then connects with a different key
- **THEN** the pending attempt shows the new key's fingerprint, an attempt count of 1, and the time of that attempt as first seen

#### Scenario: Stale attempt
- **WHEN** a pending attempt's last attempt was more than 24 hours ago
- **THEN** it is no longer listed

#### Scenario: No key
- **WHEN** a connection carries `?device=friday-kitchen` without a key
- **THEN** no pending attempt is recorded

### Requirement: A known device presenting a different key is recorded as a replacement

When a registered, non-revoked device id connects with a well-formed key that does not match its stored key, core SHALL record a pending attempt for that id under the same rules as an unknown device, and the device SHALL be listed with that pending replacement and its fingerprint. The stored key SHALL remain valid until it is replaced. A successful connection with the stored key SHALL remove the pending replacement, because the device still holds its key.

#### Scenario: Device came back after a factory reset
- **WHEN** registered device `friday-voice` connects with a new key
- **THEN** the connection is rejected as pending, and the device is listed with a pending replacement showing the new key's fingerprint

#### Scenario: Old key still works
- **WHEN** a replacement is pending for `friday-voice` and a connection presents its stored key
- **THEN** the connection is accepted, and the pending replacement is removed

### Requirement: Pending devices are accepted or ignored

The user SHALL be able to accept a pending attempt for an unregistered id. Accepting SHALL require the fingerprint the user saw, and SHALL be refused when it no longer matches the attempt's current key. Accepting SHALL take a label (the id when none is given), an optional area and optional notes. It SHALL register the device with the attempt's key and remove the attempt. The user SHALL be able to ignore a pending attempt, which removes it. A later attempt SHALL record it again.

#### Scenario: Accept
- **WHEN** the user accepts pending `friday-kitchen` with fingerprint `3f9a-c21e`, label `Kitchen satellite` and area `Kitchen`
- **THEN** `friday-kitchen` is registered with that key, label and area, the pending attempt is gone, and the device's next connection opens a session

#### Scenario: Key changed after the user looked
- **WHEN** the user accepts with fingerprint `3f9a-c21e` but the attempt's key now has fingerprint `77b0-1d4e`
- **THEN** the accept is refused, nothing is registered, and the attempt keeps the newer key

#### Scenario: Ignore
- **WHEN** the user ignores pending `friday-kitchen`
- **THEN** it is no longer listed until that device connects again

### Requirement: A device's key can be replaced

The user SHALL be able to replace a registered device's key with the key of its pending replacement. Replacing SHALL require the fingerprint the user saw, under the same rule as accepting. It SHALL keep the device's id, label, area and notes, set the time the key was replaced, remove the attempt, and close any session open with the old key. The old key SHALL no longer be accepted.

#### Scenario: Replace
- **WHEN** the user replaces the key of `friday-voice` with its pending replacement
- **THEN** connections with the new key open sessions, connections with the old key are rejected, and the label, area and notes are unchanged

### Requirement: A device's metadata can be edited

The user SHALL be able to change a registered device's label (1 to 80 characters), area (up to 80 characters, empty for none) and notes (up to 1000 characters, empty for none). Changes SHALL apply to the device's next session and SHALL NOT affect a session already open. Values outside these limits SHALL be refused.

#### Scenario: Move a satellite
- **WHEN** the user changes the area of `friday-kitchen` from `Kitchen` to `Living room` while it has a session open
- **THEN** the open session is unchanged, and the next session uses `Living room`

#### Scenario: Notes too long
- **WHEN** the user saves notes of 1001 characters
- **THEN** the change is refused with an error naming the limit

### Requirement: Devices can be revoked and deleted

The user SHALL be able to revoke a registered device. A revoked device SHALL keep its record and SHALL be rejected on every connection, whichever key it presents, without recording a pending attempt. The user SHALL be able to delete a device, revoked or not, which removes its record; a later connection from that id SHALL be recorded as pending. Revoking or deleting SHALL close the device's open session. Conversations recorded with the device's id SHALL keep that id.

#### Scenario: Revoke
- **WHEN** the user revokes `friday-kitchen`
- **THEN** its open session is closed, it is listed as revoked, and later connections from it are rejected and do not appear as pending

#### Scenario: Delete and onboard again
- **WHEN** the user deletes revoked `friday-kitchen` and the device connects again
- **THEN** it appears as a pending attempt

### Requirement: Device status shows whether it is connected

Each registered device SHALL report whether it currently has an open session and the time it last connected successfully. A device may hold more than one open session (for example, during a reconnect). It SHALL count as connected while any of them is open.

#### Scenario: Session open
- **WHEN** `friday-kitchen` has an open session
- **THEN** it is listed as connected, and its last-connected time is the time that session was accepted

#### Scenario: Session closed
- **WHEN** that session closes
- **THEN** it is listed as not connected, with the same last-connected time

### Requirement: Devices API

Core SHALL serve:
- `GET /api/devices`: `{ devices, pending }`.
  - Each device: `id`, `label`, `area`, `notes`, `fingerprint`, `createdAt`, `keyReplacedAt`, `lastSeenAt`, `revoked`, `connected`, and `replacement` (`{ fingerprint, lastSeenAt, attempts }`) when one is pending.
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

#### Scenario: Accept an unknown id
- **WHEN** `POST /api/devices/pending/nope/accept` is called and no attempt exists for `nope`
- **THEN** the response is 404

#### Scenario: Stale fingerprint
- **WHEN** `POST /api/devices/friday-voice/replace-key` carries a fingerprint other than the pending replacement's
- **THEN** the response is 409 and the stored key is unchanged

### Requirement: Voice devices page

The portal SHALL provide `Settings > Voice devices` at `/settings/devices`:
- **Devices table:** one row per registered device with a status dot (connected, idle, revoked), label, id, area, fingerprint and last connected time. A device with a pending replacement is marked in its row.
- **Pending section:** shown when any pending attempts exist, one row per attempt with id, fingerprint, first and last seen, attempt count, and `Accept` and `Ignore` actions.
- **Accept:** opens a drawer showing the id and fingerprint, with label, area and notes fields. The area field explains that it should be the Home Assistant area name or one of its aliases.
- **Clicking a device:** opens a drawer to edit label, area and notes, with `Replace key` when a replacement is pending (showing both fingerprints), `Revoke` for an active device, and `Delete` with confirmation.
- **Refresh:** a `Refresh` header action reloads the page.
- **Help text:** explains that a new device appears under pending after its first attempt to connect.

#### Scenario: Onboard a device
- **WHEN** a newly flashed device has tried to connect and the user opens the page
- **THEN** it is listed under pending with its fingerprint, and accepting it in the drawer moves it to the devices table

#### Scenario: Replacement pending
- **WHEN** a registered device came back with a new key
- **THEN** its row is marked and its drawer offers `Replace key` with the old and new fingerprints
