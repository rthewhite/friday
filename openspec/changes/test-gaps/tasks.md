# Tasks

## 1. Core test hygiene

- [x] 1.1 Remove the leaked `process.env.JELLYFIN_URL = "x"` from `packages/core/test/app.test.ts` (the `ModuleHost` there gets its own `env`). Verify the module-routes test still passes and nothing in core's tests sets `JELLYFIN_URL` on `process.env`: `grep -rn "process.env.JELLYFIN_URL" packages/core/test` prints nothing.
- [x] 1.2 Replace the real-time waits in core's tests (design decision 8). The 17 `setTimeout(r, n)` waits are in `agent-runtime`, `agent-approvals`, `agent-triggers`, `session`, `platform-api`, `mcp`, `llm-stream`, `conversations-store`, `chat-api` and `chat-engine`.
  - Waits for something to happen become `waitFor(() => condition)`.
  - Slow handlers that set an order become a deferred promise the test resolves.
  - A wait that tests a real timeout stays, with a comment.

  Verify that `pnpm --filter @friday/core test` passes 5 times in a row, and once more while `yes > /dev/null` loads every core.
- [x] 1.3 Cover the untested paths in `packages/core/src/oauth/flow.ts`: an unreadable client secret at start (409), a client without PKCE, and an expired or unknown pending state at finish. Also cover `packages/core/src/secrets/crypto.ts`: a wrong key, a tampered tag, and a scope/key mismatch on decrypt. Verify with a coverage run of core (`node --import tsx --test --experimental-test-coverage test/*.test.ts`) that lists no uncovered lines for either file.
- [x] 1.4 Run `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck`. Verify both are green.

## 2. SDK and media coverage gaps

- [x] 2.1 Cover the reconnect paths in `packages/sdk/src/remote/runner.ts` against a local `ws` server:
  - a welcome that isn't JSON
  - a message that isn't `welcome`
  - no welcome before `helloTimeoutMs`
  - a close code in `NO_RETRY_CODES`, which stops retrying
  - a retryable close, which reconnects with growing backoff
  - stopping during the wait

  Verify with the coverage run of the SDK showing `runner.ts` at 100% of functions.

  Done at 91% of functions, plus listing and calling tools over MCP, the tool-list notification, and the socket error log. The two left only swallow errors:
  - `sendToolListChanged().catch`
  - `stop()`'s `ready.catch`, after a failed `init`. Today a failed `init` ends in an unhandled rejection, and no spec says what should happen, so it's reported as a follow-up rather than tested.
- [x] 2.2 Cover `modules/media/src/index.ts`'s Jellyfin error status (`jellyfin <path> -> <status>`), marking an item played, and `nextEpisode`'s fallbacks (no next-up: first unwatched; all watched: starting over; no episodes: null), against the fake fetch. Verify with the coverage run of media showing no uncovered lines in those functions.
- [x] 2.3 Run `pnpm --filter @friday/sdk test`, `pnpm --filter @friday/module-media test` and both typechecks. Verify they are green.

## 3. Coverage report

- [x] 3.1 Add `test:coverage` to every package with `node:test` tests (core, sdk, portal, brain, builtin, calendar, media, sonos, spotify, travel, simracing): c8 with `--all` around the package's test command, as in design decision 7. (Changed from Node's built-in coverage during apply, with the user's go-ahead, because it misreports tsx code.) Stop `secrets.test.ts` from loading `crypto.ts` a second time through `createRequire`.
  - In `portal-ui`, add `vitest run --coverage` with `@vitest/coverage-v8`, pinned to the installed vitest's version.
  - At the root, add `"test:coverage": "pnpm -r build && pnpm -r test:coverage"`.

  Verify that `pnpm test:coverage` prints a per-file table for every package and exits 0.
- [x] 3.2 Add a "Testing" section to the README: `pnpm test`, `pnpm test:coverage`, that coverage lists files no test loads at 0% and has no threshold, the live tests and the eval, and `esphome/test/run.sh`. Verify each command in it runs as written.

## 4. Device protocol contract (core side)

- [x] 4.1 Write `packages/core/test/fixtures/device-protocol.json` with sections `serverMessages`, `deviceMessages`, `uris`, `deviceIds`, `alertIds` and `fingerprints`, flat as in design decision 4.
  - `serverMessages`: `interrupted`, `turn_complete`, `closed`, `ring`, `stop`, each with its meaning, plus one the firmware ignores.
  - `deviceMessages`: `ringing_locally`, `acknowledged`, `unanswered`.
  - `uris`: audio with and without an alert, control, a base URL that already has a query, and one that doesn't end in `/ws/audio`.
  - `deviceIds`: valid and invalid (length 63/64, uppercase, underscore). `alertIds`: valid and invalid, including one that core generates.
  - `fingerprints`: at least 3 vectors (key, SHA-256 hex, fingerprint).

  Verify that the file parses and that every value is a string, a boolean or a flat object (checked by the test in 4.2).
- [x] 4.2 Add `packages/core/test/device-protocol.test.ts`, which checks each part of the fixture as in design decision 4: server messages, device messages, URIs, ids and fingerprints. Verify the test passes. Then change `ring`'s shape in a scratch edit of `alerts/service.ts`, where core builds it, verify the test fails, and revert the edit.
- [x] 4.3 Run `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck`. Verify both are green.

## 5. Firmware protocol header and host tests

- [x] 5.1 Write `esphome/components/friday_client/friday_protocol.h` with only the standard library:
  - `audio_uri` and `control_uri`
  - `valid_alert_id` (device ids are checked by `__init__.py`; see design decision 3)
  - `audio_event` and `control_event` (enums with `Ignore`)
  - `control_message`
  - `format_fingerprint`

  Each is behaviour-identical to the code it replaces in `friday_client.cpp`. Verify that it compiles with `c++ -std=c++17 -Wall -Wextra -Werror -fsyntax-only`.
- [x] 5.2 Add `esphome/test/fixture.h`, a test-only reader for the fixture's flat shape that fails loudly on anything else. Add `esphome/test/friday_protocol_test.cpp`, which checks every fixture section against the header. Pass the fixture path to the test from `run.sh` (path relative to the script). Verify that `esphome/test/run.sh` passes all three test files. Then change one expected message in a scratch copy of the fixture, verify the firmware test fails, and revert.
- [x] 5.3 Make `friday_client.cpp` use the header: the URI building, `valid_alert_id`, the `type` dispatch after `json::parse_json` on both sockets, `ctrl_send_`'s message, and the fingerprint formatting after `mbedtls_sha256`. Verify that `esphome config` and `esphome compile` succeed locally for `friday-voice-pe.yaml` and `friday-respeaker.yaml`. Verify that `run.sh` still passes.
- [x] 5.4 Update the `openspec/config.yaml` context: `friday_client` has a pure `friday_protocol.h`, and the host tests check it against core's protocol fixture. Verify that `openspec validate test-gaps --strict` passes.

## 6. CI: firmware tests and the boot check

- [x] 6.1 Check that the self-hosted runner has a C++17 compiler (`c++ --version` in a `workflow_dispatch` run, or on the runner host). If it doesn't, stop and ask the user to install one (`build-essential`); that's a homelab change. Verify with the compiler version in the run's log.

  Outcome: the homelab's `build-host` role installs no compiler. The user chose to run the tests in a digest-pinned `gcc:14` image instead (design decision 2). GCC 14 passes them locally with `-Werror`. The run on the runner itself is checked in 9.2.
- [x] 6.2 Add `esphome/test/run.sh` as a step in `deploy.yml`'s `test` job, after the package tests, run in the `gcc:14` image. Add `.github/workflows/firmware.yml`, which triggers on push to `esphome/**` and on `workflow_dispatch` and runs only that step on the homelab runner. Verify with `actionlint` (or a YAML parse if it isn't installed) and by reading both workflows' triggers against the spec's firmware-only scenario.
- [x] 6.3 Write `scripts/smoke.env` with `.invalid` placeholders for `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `TOMTOM_API_KEY`, `HA_URL`, `HA_TOKEN`, `INTAKE_URL` and `INTAKE_KEY`. It has no iCloud keys and no Gemini key, and a comment says why. Write `scripts/smoke.sh <image>` as in design decision 1:
  - `docker run -d` in a fresh container (its own empty `/data`), with the env file and a generated `FRIDAY_MASTER_KEY`
  - every probe through `docker exec … node -e fetch(...)` to `127.0.0.1:8080`
  - `/health` within 60 s, `/` as the portal's HTML, and `/api/modules` with `core` first and everything `loaded`
  - `docker stop -t 10`, then exit code 0
  - logs printed on failure, and the container always removed

  Fix `.dockerignore` so no `.env` or `data/` at any depth enters the image.

  Verify by building the image locally (`docker build -t friday:smoke .`): `scripts/smoke.sh friday:smoke` passes, and the image has no `/app/.env`. Then make a scratch image with `JELLYFIN_URL` removed from the env file, and one with `FRIDAY_WEB_DIR=/nope`. Verify each fails with the expected message and the log printed.
- [x] 6.4 In `deploy.yml`'s `build` job, replace `buildx build --push` with three steps: `buildx build --load --tag "$IMAGE:$GITHUB_SHA"`, then `scripts/smoke.sh "$IMAGE:$GITHUB_SHA"`, then `docker push "$IMAGE:$GITHUB_SHA"`, keeping the registry login and logout. Verify with `actionlint` and by reading the job: push comes after the check, and no `--push` remains.
- [x] 6.5 Document the boot check and the `gcc` image in `infra/README.md`. Update `openspec/config.yaml`'s context: the firmware tests and the boot check run in CI. Verify that `openspec validate test-gaps --strict` passes.

## 7. Weekly live checks

- [x] 7.1 Add `test:live` to `packages/core`. It runs the live tests with `FRIDAY_LIVE_TESTS=1` and `--test-name-pattern="^live: "`, fails without `GEMINI_API_KEY`, and fails when no test passed, so a rename can't make it pass by matching nothing. Verify that without the key it exits non-zero with a message naming `GEMINI_API_KEY`. With the key from `.env`, verify it runs and passes the 3 live tests.
- [x] 7.2 Add `.github/workflows/live-checks.yml` as in design decision 6:
  - `schedule` at `0 6 * * 1` and `workflow_dispatch`, on the homelab runner
  - a first step that fails when `secrets.GEMINI_API_KEY` is empty
  - install and build
  - `pnpm --filter @friday/core test:live`, then `pnpm --filter @friday/module-brain eval`
  - no registry or kube steps

  Verify with `actionlint` and that the file has no `docker`, `kubectl` or registry secret references.
- [x] 7.3 Document the `GEMINI_API_KEY` repository secret and the weekly run in `infra/README.md`, and add the live checks to the README's Testing section. Verify that the documented commands run as written.

## 8. Portal tests

- [x] 8.1 Extract the pure parts of `ConnectionsPage.vue` into `src/lib/connections.ts`: redirect URI, provider id, dirty, can-save and the save body. Do the same for `McpServersTab.vue` into `src/lib/mcp-servers.ts`: can-save, body and the `?server=` query. The pages use them, and their behaviour is unchanged. Verify with `test/connections.test.ts` and `test/mcp-servers.test.ts` (generic vs catalogue provider, an unchanged stored secret not sent, headers kept secret) and `pnpm --filter @friday/portal typecheck`.
- [x] 8.2 Test `useChatStream` under `node:test`, with a fake `fetch` returning a streamed `Response`. Verify `test/use-chat-stream.test.ts` covers:
  - text deltas, tool events, and the conversation id from `start`
  - a 4xx answer and a stream that breaks mid-turn
  - a request that fails on the network. (Planned as "aborting a send", but `useChatStream` has no abort.)
- [x] 8.3 Test `useVoiceSession` under `node:test`, with fake `WebSocket`, `AudioContext`, `AudioWorkletNode` and `navigator.mediaDevices` on `globalThis`, restored after each test. Verify `test/use-voice-session.test.ts` covers:
  - connecting, then live
  - a transcript entry for each event type
  - `interrupted` dropping queued playback
  - a refused microphone giving an `error:` state
  - `stop(true)` draining before close
- [x] 8.4 Add `vitest`, `@vue/test-utils` and `happy-dom` as dev dependencies of the portal, with vitest pinned to `portal-ui`'s version. Add `vitest.config.ts` with the Vue plugin, the happy-dom environment and `include: ["test/components/**/*.test.ts"]`. Make `test` run `node:test` and then `vitest run`. Verify that `pnpm --filter @friday/portal test` runs both and that neither picks up the other's files.
- [x] 8.5 Add the component tests in `test/components/`, with `api` mocked:
  - **AgentEditor:** saving a new agent sends the expected body and navigates; a 400 shows the server's error.
  - **McpServersTab:** a save error keeps the drawer open with the error.
  - **ConnectionsPage:** a stored client secret isn't shown and isn't sent unless changed.

  No snapshots. Verify that `pnpm --filter @friday/portal test` and `pnpm --filter @friday/portal typecheck` are green.

## 9. Integration

- [ ] 9.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`, `esphome/test/run.sh`, and `scripts/smoke.sh` against a freshly built local image. Verify all are green.
- [ ] 9.2 With the user's approval, push the branch: a branch push builds an image, which now has to pass the boot check before it is pushed. Verify in the Actions run that `test` (with the firmware step) and the boot check pass and the image is pushed after it.
- [ ] 9.3 Needs the user: add the `GEMINI_API_KEY` repository secret and start `live-checks` by hand (`gh workflow run live-checks.yml`). Verify that the run passes, or that its failures are real model drift recorded as follow-ups.
- [ ] 9.4 Needs the user, at home: flash the firmware built from this branch to the Voice PE (OTA) and the reSpeaker. Check that onboarding still shows the same fingerprint, that a voice turn with barge-in works, and that a timer rings and is acknowledged. Verify by the user confirming each.
