# Proposal

## Why

The package tests are strong: about 1,420 tests, 92–99% line coverage of the files they load, green in 6 seconds. Their gaps are at the edges, and those are where a deploy can still break:

- **The real server never starts before production.** `packages/core/src/server.ts` (174 lines that build everything at startup) is never loaded by a test. CI builds and pushes the image without running it. The first start is the Kubernetes rollout on the homelab.
- **The portal's code is mostly untested.** About 2,500 lines of `.vue` pages and about 800 lines of module UI are never loaded by a test. The same goes for `useChatStream.ts` and `useVoiceSession.ts`, which hold the streaming chat and the browser voice session.
- **The firmware is outside CI.** `esphome/test/run.sh` exists but nothing runs it. `friday_client.cpp` (911 lines) speaks `/ws/audio` and `/ws/device` and has no tests, so drift between core and the devices goes unnoticed.
- **The real model is never checked on a schedule.** The three live Gemini tests and the brain eval only run when someone remembers. `FRIDAY_TEXT_MODEL` defaults to `gemini-flash-latest`, an alias that Google moves to newer models over time, so behaviour can change without a commit here.

## What Changes

- **Boot check before an image is pushed.** CI builds the image locally, starts it with an empty data directory, and checks `/health`, the portal at `/`, `/api/modules`, and a clean exit on `SIGTERM`. Only then does it push the image. The check is a script that can also be run locally.
- **Firmware tests in CI.** The `test` job runs `esphome/test/run.sh`.
- **A pure protocol header for `friday_client`.** The decisions around `/ws/audio` and `/ws/device` move out of `friday_client.cpp` into `friday_protocol.h`, which gets C++ host tests. These are building URIs, checking ids, choosing what an incoming message means, building outgoing messages, and formatting the key fingerprint. JSON parsing stays with ESPHome. What the device does is unchanged.
- **A shared device protocol contract.** One fixture file lists the messages core and the devices exchange, plus fingerprint test vectors. Core's tests and the firmware's host tests both check against it.
- **Weekly live checks.** A scheduled GitHub workflow, which can also be started by hand, runs core's live Gemini tests and the brain eval against the real model, using a new `GEMINI_API_KEY` repository secret. It fails visibly and never blocks a deploy.
- **Portal tests.**
  - The two composables get tests with fake `fetch`, `WebSocket` and audio objects.
  - Logic in `ConnectionsPage.vue` and `McpServersTab.vue` moves into `src/lib/*.ts` with tests, the pattern the portal already uses.
  - A few component tests (vitest, `@vue/test-utils`, happy-dom) cover what those pages and `AgentEditor.vue` do on save and on errors. There are no snapshot tests.
- **Smaller fixes:**
  - Core tests that wait on real `setTimeout` sleeps wait on a condition or a controlled promise instead.
  - The leaked `process.env.JELLYFIN_URL` in `app.test.ts` is removed.
  - The untested paths in `oauth/flow.ts`, `secrets/crypto.ts`, the SDK's `remote/runner.ts` and `modules/media` get tests.
  - Each package gets a `test:coverage` script, based on c8. It reports coverage, lists files no test loads at 0%, and enforces no threshold.

## Capabilities

### New Capabilities

- `ci-pipeline`: what CI checks before an image is pushed and deployed (tests, typecheck, firmware host tests, the boot check), the shared device protocol contract, the weekly live checks, and the coverage report.

### Modified Capabilities

None. The brain eval stays opt-in and outside `pnpm test`, as `brain-maintenance` requires; the workflow only runs it on a schedule. The firmware refactor does not change what the devices do (`voice-pe-client`, `respeaker-client`, `alerts`).

## Impact

- **CI:**
  - `.github/workflows/deploy.yml`: the firmware step in `test`; build, check, then push in `build`.
  - New `.github/workflows/firmware.yml`: firmware-only pushes, which don't trigger `deploy.yml`.
  - New `.github/workflows/live-checks.yml`.
  - New `scripts/smoke.sh` and `scripts/smoke.env`.
- **Secrets:** a new repository secret `GEMINI_API_KEY`, documented in `infra/README.md`. The self-hosted runner needs a C++17 compiler (`c++`).
- **Firmware:** new `esphome/components/friday_client/friday_protocol.h`, `friday_client.cpp` using it, and new `esphome/test/friday_protocol_test.cpp` with a small test-only fixture reader. Needs a check on a device at home (Voice PE or reSpeaker: onboarding, a voice turn, a timer that rings) before archiving.
- **Contract:** new `packages/core/test/fixtures/device-protocol.json`, read by a new core test and by the firmware host test.
- **Core:** tests only, plus a `test:live` script. `server.ts` is unchanged.
- **Portal:**
  - Composable and component tests.
  - New `src/lib/connections.ts` and `src/lib/mcp-servers.ts`.
  - Dev dependencies on `vitest`, `@vue/test-utils` and `happy-dom`, matching `portal-ui`'s vitest version.
  - The `test` script runs `node:test` and then vitest.
- **SDK, media:** tests only.
- **Coverage:** every package with tests gets a `test:coverage` script, and the root gets one too. New root dev dependency `c8`; `portal-ui` gets `@vitest/coverage-v8`. The `coverage/` folders are ignored.
- **Docs:** README (testing section), `infra/README.md` (the secret, the runner's compiler), and the `openspec/config.yaml` context: the firmware tests and the boot check now run in CI.
- **Overlap with `auth-users`** (planned, with a worktree):
  - After it lands, `/api/*` answers 401 without a session.
  - The boot check sends its requests from inside the container, a loopback address, which `auth-users` gives the dev admin when auth isn't configured. So it should work unchanged. Whichever change merges second re-runs it after the rebase.
  - `auth-users` also changes the portal's API client and SSE handling, which the new composable tests cover; those merge conflicts are mechanical.
- **Overlap with `sonos-speakers`:** none. It touches the `Dockerfile` and module lists, not CI or tests outside its own module.
