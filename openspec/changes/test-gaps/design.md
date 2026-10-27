# Design

## Context

- **CI.** `deploy.yml` has three jobs on the self-hosted homelab runner. `test` runs install, build, typecheck and test. `build` runs `docker buildx build --push` in one step. `deploy` applies `deploy/k8s.yaml` on `main`. The workflow triggers only on runtime paths, and `esphome/**` isn't one of them.
- **A boot with no configuration** (tried locally with `dist/server.js`, an empty environment and an empty data directory):
  - `/health` answers 200.
  - `/` serves the portal.
  - `/api/modules` lists `core`, `builtin`, `brain` and `spotify` as `loaded`. `media`, `travel`, `calendar` and `sonos` are `failed` for missing configuration, each with its own message.
  - `SIGTERM` exits with code 0.
- **Firmware.** `friday_client.cpp` parses JSON with ESPHome's ArduinoJson wrapper (`json::parse_json`), hashes with mbedtls, and holds the decisions inline: `valid_alert_id`, URI building, type `strcmp`s, and `ctrl_send_`. None of that compiles on a host. `xvf3800_protocol.h` and `decimator.h` already show the pattern: a pure header, tested by `esphome/test/*_test.cpp` with the tiny `test.h` harness.
- **Core's protocol.** `transports/device-ws.ts` documents the `/ws/device` messages: `{"type":"ring","data":{"alert":"<id>"}}` from the server and `{"type":"acknowledged","alert":"<id>"}` from the device. `transports/ws.ts` sends a device only `interrupted`, `turn_complete` and `closed`.
- **Portal tests.** The portal tests `.ts` with `node:test` and has no way to load `.vue` files. `portal-ui` uses vitest 3.2 with `@vitejs/plugin-vue` for that, which works with the portal's Vite 7.
- **Live tests.** Core's live tests skip unless `FRIDAY_LIVE_TESTS=1` and `GEMINI_API_KEY` are set. Without the key they'd count as skipped, which reads as green. The brain eval exits 1 on any failed expectation and 2 without a key.

## Goals / Non-Goals

**Goals:**
- The boot check catches what tests can't: wiring in `server.ts`, the `Dockerfile` (portal copied, `FRIDAY_WEB_DIR`, native `node:sqlite`), migrations on an empty database, module init, and shutdown.
- A protocol change that's made on one side only fails a test on the other.
- Test-only work changes no runtime behaviour. The firmware refactor is behaviour-preserving.

**Non-Goals:**
- Building the firmware in CI (`esphome compile`). It needs the ESPHome toolchain and minutes per device. The pure headers cover the logic that changes most.
- End-to-end browser tests (Playwright). The composable and component tests cover the logic. A real browser against a real server is a later step if UI regressions show up.
- Coverage thresholds (see decision 7).
- Testing `server.ts` in-process. The boot check covers it as a black box.

## Decisions

### 1. The boot check is a script against the built image, between build and push

**Where it runs.** `scripts/smoke.sh <image>` runs the image with `docker run` and no published port. Every probe runs inside the container with `docker exec <c> node -e "fetch('http://127.0.0.1:8080/…')"`; the image already has Node. Probing from inside means no port is used on the shared runner, and the requests come from a loopback address, which matters for `auth-users` (see Risks). In `deploy.yml`'s `build` job, `buildx build --push` becomes three steps: `buildx build --load`, then `smoke.sh`, then `docker push`. Pushing only after the check means a broken image is never in the registry under a SHA, so it can't be deployed by hand either.

**How it works:**
- An empty data directory: a fresh container's own `/data`, which the image creates for user `node`. (A `--tmpfs` mount would be owned by root and refuse writes.)
- `FRIDAY_MASTER_KEY` generated per run (32 bytes from `/dev/urandom`, base64), so the encrypted-config path initializes too.
- No `GEMINI_API_KEY`.
- Placeholders from `scripts/smoke.env` for every module's required keys:
  - `JELLYFIN_URL`, `JELLYFIN_API_KEY`
  - `TOMTOM_API_KEY`
  - `HA_URL`, `HA_TOKEN`
  - `INTAKE_URL`, `INTAKE_KEY`

  URLs use `.invalid` hosts (RFC 2606), which fail DNS at once.
- The script polls `/health` for up to 60 s, checks that `/` holds the portal's `#app` and a built `/assets/` script, and checks with `node -e` that `/api/modules` is `core` first and every entry `loaded`. Then it runs `docker stop -t 10` and expects exit code 0 from `docker inspect`.
- On any failure it prints `docker logs` and exits non-zero. A trap always removes the container.
- `deploy.yml` also triggers on `scripts/**`, so a change to the check runs it.

**Local images must not carry a `.env`.** Building the image in a worktree first passed the check for the wrong reason. `.dockerignore` excluded only the root `.env`, so `packages/core/.env`, where `CLAUDE.md` puts it in worktrees, went into the image. dotenv then loaded your real configuration there. `.dockerignore` now excludes `.env`, `.env.*` and `data/` at any depth. CI checkouts never have a `.env`, so images in the registry weren't affected.

**Alternatives considered:**
- *Accept `failed` for modules missing configuration.* Each module words that error differently (calendar names its sources), so the check would have to parse messages, and a real init crash in an unconfigured module would pass.
- *Boot `dist/server.js` without Docker.* That is cheaper, but misses the `Dockerfile`, which is half of what can break.

**Calendar gets only the intake keys.** Never the iCloud ones: the CalDAV client sends Basic auth to `*.icloud.com`, which would put fake credentials on a real service.

### 2. Firmware tests run in `deploy.yml`'s `test` job, and in a small `firmware.yml` for firmware-only pushes

- **`deploy.yml`.** The `test` job runs `esphome/test/run.sh`, so a core-side change to the contract fixture is checked against the firmware in the same gate that guards deploys.
- **`firmware.yml`.** Adding `esphome/**` to `deploy.yml`'s paths would rebuild and redeploy an identical image on every firmware commit, restarting Friday on `main` for nothing. So `firmware.yml` triggers on `esphome/**` and runs only `run.sh`.
- **Compiler.** The runner has Docker but no compiler: the homelab's `build-host` role installs only base packages. So both workflows run `run.sh` in a `gcc:14` image pinned by digest (`GCC_IMAGE`), with the checkout mounted read-only. That needs no homelab change and pins the compiler in the repository. GCC 14 passes the tests with `-Werror` (checked locally). *Alternative considered:* `build-essential` on the runner via the homelab's Ansible. That's a change outside this repository, and the compiler would follow Ubuntu's version.

### 3. `friday_protocol.h`: decisions in a pure header, JSON and SHA-256 stay in ESPHome

The new header in `esphome/components/friday_client/` uses only the standard library. It holds:

- `audio_uri(base, device, alert)` and `control_uri(base, device)`
- `valid_alert_id`, moved from the `.cpp`
- `audio_event(type)`, returning `Interrupted`, `TurnComplete`, `Closed` or `Ignore`
- `control_event(type, alert)`, returning `Ring`, `Stop` or `Ignore`
- `control_message(type, alert)`, the exact JSON string the device sends
- `format_fingerprint(digest[32])`

`friday_client.cpp` keeps `json::parse_json` and `mbedtls_sha256` and calls the header for everything after them.

**Device ids aren't checked at runtime.** The firmware checks them when the YAML is validated: `__init__.py`'s `DEVICE_ID` is the same pattern as core's `DEVICE_ID` in `devices/store.ts`. So there's no `valid_device_id` in the header. Instead, core's contract test checks that the two patterns are identical.

**Alternative considered:** move the JSON parsing into the header with a hand-written parser. It would test more, but it replaces a library the device relies on with our own code, for little gain. The messages are flat and small.

### 4. The contract fixture lives with core, in a flat JSON shape C++ can read

`packages/core/test/fixtures/device-protocol.json` is owned by core, the protocol's server. It has an `about` string and the sections `serverMessages`, `deviceMessages`, `uris`, `deviceIds`, `alertIds` and `fingerprints`. Each section is an array of objects whose values are strings or booleans, so a test-only reader can extract the values without a JSON library.

**C++ side.** That reader, `esphome/test/fixture.h`, is about 80 lines and only handles this shape; it fails loudly on anything else. `run.sh` passes the fixture's path as an argument.

**Core side.** A new `device-protocol.test.ts` covers four parts:

- **Server messages.**
  - `/ws/audio`: a device connection on the real transport gets each listed message as raw text, and not the browser-only ones.
  - `/ws/device`: `AlertService` rings and stops a device. Its link socket records the raw text, with the random alert id swapped for the fixture's.
- **Device messages.** It sends each one on the real `/ws/device` and checks that `onReport` receives the listed type and alert.
- **URIs.** It connects with each listed audio URI and checks that core read the device, and the alert where there is one. It connects with each control URI and checks that the device comes online.
- **Ids.**
  - `DEVICE_ID` accepts exactly the listed device ids, and `__init__.py` uses the same pattern.
  - The alert ids core generates match the firmware's rule, and the fixture's alert ids follow it.
- **Fingerprints.** `hashKey(key)` and `fingerprint(...)` must equal the fixture's values.

**Alternative considered:** generate a C++ header from the JSON with a Node script in `run.sh`. That would make `run.sh` need Node and add a generation step. A reader of about 80 lines in the test folder is simpler.

### 5. Portal: extract first, then a few vitest component tests

**Extract and test with `node:test`:**
- `src/lib/connections.ts` takes the pure parts of `ConnectionsPage.vue`: `redirectUri`, `providerId`, `dirty`, `canSave` and the save `body`.
- `src/lib/mcp-servers.ts` does the same for `McpServersTab.vue`: `canSave`, `body`, and parsing the `?server=` query.
- `AgentEditor.vue` already has `lib/agents.ts`.

**Composables.** They are plain Vue reactivity and run under `node:test` with fakes on `globalThis`:
- `useChatStream`: a fake `fetch` returning a streamed `Response`, covering text deltas, tool events, the conversation id from `start`, a 4xx, a broken stream, and abort.
- `useVoiceSession`: fake `WebSocket`, `AudioContext`, `AudioWorkletNode` and `navigator.mediaDevices`, covering connecting to live, transcript entries per event type, `interrupted` dropping playback, a refused microphone giving an error state, and `stop(drain)`.

**Component tests.** A handful run under vitest + `@vue/test-utils` + happy-dom in `test/components/`, with `api` mocked. They cover what the pages do with the lib and the API:
- AgentEditor: saving a new agent sends the expected body and navigates; a 400 shows the server's error.
- McpServersTab: a save error keeps the drawer open.
- ConnectionsPage: a stored client secret isn't shown and isn't sent unless changed.

**The test script.** The portal's `test` runs `node --import tsx --test …` and then `vitest run`. Vitest's `include` covers only `test/components/**`, so the two runners never pick up each other's files.

**Alternative considered:** move all portal tests to vitest. That churns 51 working tests for nothing. Two runners, one script, is explicit.

### 6. Live checks: a separate weekly workflow that refuses to run without the key

`.github/workflows/live-checks.yml` runs on `schedule: cron "0 6 * * 1"` (Monday 06:00 UTC) and on `workflow_dispatch`, on the homelab runner. Its steps:

1. Fail at once with `GEMINI_API_KEY secret is not set` if the secret is empty.
2. Install and build.
3. `pnpm --filter @friday/core test:live`. That's a new script: `FRIDAY_LIVE_TESTS=1 node --import tsx --test --test-name-pattern="^live: " test/*.test.ts`. It also fails if no test ran, so a renamed test can't turn the run green by matching nothing.
4. `pnpm --filter @friday/module-brain eval`.

Neither the eval nor the live tests set `FRIDAY_TEXT_MODEL`, so they use the default alias, which is the point. The workflow has no build or deploy steps and doesn't write to the registry. A failed run is signalled through GitHub's standard failure notification.

### 7. Coverage: c8 with `--all`, report only

- Every package with `node:test` tests gets `test:coverage`: `c8 --all --src src --include 'src/**' --exclude 'src/**/*.d.ts' --exclude 'src/modules.gen.ts' --reporter text --clean`, followed by its test command. c8 is a root dev dependency, and each package writes to its own ignored `coverage/` folder.
- `portal-ui` gets `vitest run --coverage --coverage.include=src/**` with `@vitest/coverage-v8`, pinned to its vitest version.
- The portal reports only its `node:test` part. c8 sees `.ts` and `.js` files, not `.vue`.
- The root `test:coverage` is `pnpm -r build && pnpm -r test:coverage`.

**Why c8 over Node's built-in coverage.** We tried Node's built-in coverage first; with tsx it misleads either way:
- Without `--enable-source-maps`, uncovered line numbers point at the wrong lines. One run blamed the interface fields of `oauth/flow.ts`.
- With it, some packages count type-only and comment lines as uncovered. The portal read 66.8% for code that is about 99% covered.

c8 reads the same V8 data through the source maps, ignores type-only lines, and with `--all` lists files no test imports at 0%. That puts `server.ts` and the portal's composables, which this change is about, at the top of the list. A file of types only (travel's `types.ts`) always reads 0%; the README says so.

**A module loaded twice is misreported.** `secrets.test.ts` loaded `crypto.ts` both through `import` and through `createRequire`. That gave V8 two copies of the file, and c8's merge reported tested functions as unhit. The test now uses the import. Tests should not `require` source files.

**No threshold.** A threshold would push coverage of what's easy to test rather than what's risky. The report is for finding gaps, like the 0% files above.

### 8. Real-time waits

Of the 17 `setTimeout(r, n)` waits in core's tests, there are two kinds:
- **Waiting for something to happen**, for example `agent-triggers`' `settle` or `session.test`'s 50 ms. These become `waitFor(() => condition)`.
- **Slow tool handlers that set an order**, for example `chat-engine`'s 20 ms and `chat-api`'s 80 ms against a 10 ms heartbeat. These become a deferred promise the test resolves at the point the order needs.

A wait that tests a real timeout stays, with a comment saying why.

## Risks / Trade-offs

- **[`auth-users` changes what a boot sees]**
  - After it lands, `/api/*` answers 401 without a session.
  - Its design gives a request from a loopback peer the dev admin when auth isn't configured, and refuses to start only with a non-localhost `FRIDAY_PUBLIC_URL`.
  - → The boot check probes from inside the container (`127.0.0.1`) and sets neither auth nor `FRIDAY_PUBLIC_URL`, so it gets the dev admin and works unchanged before and after that change.
  - Whichever change merges second re-runs `smoke.sh` after the rebase to confirm it.
- **[Self-hosted runner lacks `c++`]** → The first task checks it. Installing a compiler on the runner is a manual homelab step for the user.
- **[Placeholder config drifts]** A new module with required keys fails the boot check until `smoke.env` is updated. That's intended (see the spec scenario), and the failure names the module and the key.
- **[Boot check reaches the network]** Modules with placeholders may try their hosts at startup, for example calendar's refresh job. → Only `.invalid` hosts are used, which fail in DNS without leaving the runner. No real credentials, and no iCloud keys.
- **[Weekly live run is flaky by nature]** One bad sample from the model fails the run. → Accepted: it's a signal, not a gate. Re-running by hand distinguishes noise from drift.
- **[Live checks cost money]** About 16 eval fixtures × a few calls, plus 3 live tests, once a week, on the Flash tier. That's negligible.
- **[Firmware refactor regresses a device]** → It's behaviour-preserving, with host tests first. `esphome config` and a compile for both YAMLs run locally, and a device check at home (onboarding, a voice turn with barge-in, a timer that rings and is acknowledged) happens before archiving.
- **[Two test runners in the portal]** → Kept apart by folder and `include`. The README's testing section says which goes where.

## Migration Plan

1. Merge on `main`. The first push runs the new `test` step (firmware) and the boot check before the push. If the boot check blocks a deploy, `smoke.sh` reproduces it locally against the same tag.
2. Before the first weekly run, the user adds the `GEMINI_API_KEY` repository secret (documented in `infra/README.md`). Until then the live workflow fails, naming the secret, and nothing else is affected.
3. Rollback: revert the merge. No data, migrations or runtime behaviour change.
