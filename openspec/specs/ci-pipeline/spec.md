# CI Pipeline

## Purpose

What Friday's CI checks before an image is pushed and deployed, how the device firmware and core are held to one protocol, and that live model checks stay out of CI.

## Requirements

### Requirement: CI gates every image on the checks

On every push that touches runtime files, CI SHALL build the workspace, typecheck every package, run every package's tests and run the firmware host tests. An image SHALL be built, pushed and deployed only when all of these pass. On a push that touches only firmware files, CI SHALL run the firmware host tests and SHALL NOT build, push or deploy an image.

#### Scenario: A package test fails
- **WHEN** a push to any branch has a failing test in any package
- **THEN** the run fails and no image is pushed

#### Scenario: A firmware host test fails
- **WHEN** a push that touches runtime files has a failing firmware host test
- **THEN** the run fails and no image is pushed

#### Scenario: Firmware-only push
- **WHEN** a push changes only files under `esphome/`
- **THEN** the firmware host tests run, and no image is built or deployed

### Requirement: An image must boot before it is pushed

After building an image and before pushing it, CI SHALL start it with an empty data directory, a freshly generated master key, no Gemini key, and placeholder values for every module's required configuration. The placeholders SHALL name hosts that cannot be reached, and SHALL never be credentials for a real service. Within 60 seconds:

- `/health` SHALL answer 200.
- `/` SHALL serve the portal's HTML.
- `/api/modules` SHALL list `core` first and every in-process module with status `loaded`.

On `SIGTERM` the container SHALL then exit with code 0 within 10 seconds. If any check fails, CI SHALL print the container's log, fail the run, and not push the image. The same check SHALL be runnable locally against an image tag.

#### Scenario: A healthy image
- **WHEN** CI builds an image whose server starts and whose modules all initialize
- **THEN** every check passes and the image is pushed

#### Scenario: A module throws during start-up
- **WHEN** a module's initialization throws in the built image
- **THEN** `/api/modules` shows it as `failed`, the check fails with the container's log printed, and no image is pushed

#### Scenario: The server never listens
- **WHEN** the server crashes during start-up, for example on a failing migration
- **THEN** `/health` never answers, the check fails within 60 seconds with the container's log printed, and no image is pushed

#### Scenario: The portal is missing from the image
- **WHEN** the image does not contain the built portal
- **THEN** `/` does not serve the portal's HTML, and no image is pushed

#### Scenario: Unclean shutdown
- **WHEN** the container does not exit with code 0 within 10 seconds of `SIGTERM`
- **THEN** the check fails and no image is pushed

#### Scenario: A new module needs configuration
- **WHEN** a module with a new required configuration key is added and the check has no placeholder for it
- **THEN** the module reports `failed` and the check fails until a placeholder is added

### Requirement: Core and the device firmware share one protocol contract

The repository SHALL hold one fixture describing the device protocol, with these parts:

- **Server to device messages.** On `/ws/audio`: `interrupted`, `turn_complete` and `closed`. On `/ws/device`: `ring` and `stop`. Each is given exactly as core sends it, with the meaning the device must give it.
- **Device to server messages.** On `/ws/device`: `ringing_locally`, `acknowledged` and `unanswered`, each exactly as the device sends it.
- **URIs.** The audio and control URIs a device builds from a base URL, its device id and an optional alert id.
- **Ids.** Device ids and alert ids that must be accepted or refused.
- **Fingerprints.** Key fingerprint vectors: a key, its SHA-256, and the fingerprint shown in the portal.

Core's tests and the firmware's host tests SHALL check both sides against this fixture, as follows:

- **Core** sends exactly the listed server messages, accepts the listed device messages, and accepts and refuses the listed device ids. Its fingerprints match.
- **The firmware** gives each server message its listed meaning, builds the listed device messages and URIs, accepts and refuses the listed ids, and formats the listed fingerprints.

#### Scenario: Core changes a message
- **WHEN** core changes the shape of a `ring` message without updating the fixture
- **THEN** core's contract test fails

#### Scenario: The firmware changes a message
- **WHEN** the firmware builds an `acknowledged` message that differs from the fixture
- **THEN** the firmware host test fails

#### Scenario: The protocol changes on purpose
- **WHEN** the fixture is updated for a new message shape and only core is changed to match
- **THEN** the firmware host test fails until the firmware matches too

#### Scenario: Fingerprints agree
- **WHEN** a device's key is in the fixture's fingerprint vectors
- **THEN** core and the firmware produce the same fingerprint for it

### Requirement: The real model is checked by hand, never in CI

Core SHALL provide one command that runs its live model tests against the real text model (`FRIDAY_TEXT_MODEL`'s default), with the Gemini key from the environment or core's `.env`. If any live test fails, the command SHALL fail. If the key is missing, it SHALL fail and name the key, rather than skip the tests. If no live test ran, it SHALL fail. The live tests and the brain eval SHALL stay out of the regular test run, and no CI workflow SHALL run them, so CI never spends money on model calls.

#### Scenario: Missing key
- **WHEN** the live test command runs without a Gemini key
- **THEN** it fails with a message naming the missing key, and no live test is reported as skipped-and-passed

#### Scenario: Renamed live tests
- **WHEN** the live tests are renamed so that none matches the command's pattern
- **THEN** the command fails and says that no live test ran

#### Scenario: CI makes no model calls
- **WHEN** any CI workflow runs, on any trigger
- **THEN** it runs neither the live tests nor the brain eval

#### Scenario: Regular test runs stay offline
- **WHEN** the regular package tests run, in CI or locally
- **THEN** the live tests are skipped and the brain eval does not run

### Requirement: Coverage can be reported per package

Every package with tests SHALL offer a coverage command. It SHALL run the same tests as the package's test command and report line, branch and function coverage for each TypeScript and JavaScript source file of the package. Files no test loads SHALL be listed at 0% rather than left out. Line numbers SHALL refer to the TypeScript source, and lines that hold only types SHALL NOT count as uncovered. A root command SHALL run it for every package. Coverage SHALL NOT have a threshold and SHALL NOT gate CI.

#### Scenario: Coverage for one package
- **WHEN** a developer runs the coverage command for a package
- **THEN** its tests run and a per-file coverage table is printed, excluding test files and dependencies

#### Scenario: A file no test loads
- **WHEN** a source file is never imported by any test, such as core's `server.ts`
- **THEN** the table lists it at 0% with all its lines uncovered

#### Scenario: Coverage does not gate CI
- **WHEN** a change lowers coverage while all tests pass
- **THEN** CI still passes
