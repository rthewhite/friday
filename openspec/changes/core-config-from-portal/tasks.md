# Tasks

## 1. Core as a configuration requester

- [ ] 1.1 Add `packages/core/src/core-config.ts` with `CORE_ID`, `coreManifest` (`GEMINI_API_KEY`: secret, required, with a description) and `coreConfig(store, env)`, and verify with a unit test that it resolves `core` scope, then `global`, then env
- [ ] 1.2 Include `coreManifest` in `configListing` and `isDeclaredSecret`, and accept scope `core` in `PUT /api/config/:scope/:key`. Verify with `platform-api.test.ts` cases: the listing has `GEMINI_API_KEY` with `modules: [{ id: "core", required: true }]` and no value, a PUT for `core` is stored encrypted with status `set` and scope `core`, a `global` PUT with `secret: false` is still stored encrypted, and scope `nope` gives 404

## 2. Key resolved at use

- [ ] 2.1 Give `GeminiSession` a `geminiKey` option (default `() => settings.apiKey`), resolve it once in `open()`, and pass it to `connect(params, apiKey)`. Thread `geminiKey` through `attachAudioWs`. Verify with `session.test.ts` that a stub `connect` receives the key current at open, and that a key changed afterwards reaches only the next session
- [ ] 2.2 Let `GeminiTextModel` take a key function, resolving it per call and caching one client per key value. Verify with `llm-gemini.test.ts`: a changed key gets a new client, an unchanged key reuses the client, and an empty key is `unavailable: GEMINI_API_KEY is not configured`
- [ ] 2.3 Create `geminiKey` from `coreConfig` in `server.ts`, pass it to `attachAudioWs` and `GeminiTextModel`, and base the startup warning on it. Verify by starting core locally on a spare port with a temp data dir and no env key: the warning is logged, and after a `PUT /api/config/core/GEMINI_API_KEY` the listing reports `set` for scope `core`

## 3. Portal and docs

- [ ] 3.1 In `ConfigurationPage.vue`, show no reload action for scope `core`, label it "core only", and add the "Applies to the next voice session and model call." hint. Verify `pnpm --filter @friday/portal build` passes and the drawer for `GEMINI_API_KEY` against a local core shows `Save` and `Clear` only
- [ ] 3.2 Update `infra/README.md` (`GEMINI_API_KEY` can be set in the portal; `friday-secrets` then only needs `FRIDAY_MASTER_KEY`; no restart needed to rotate it) and the `.env.example` comment, and verify they match the behaviour

## 4. Integration

- [ ] 4.1 Run `pnpm test` and `pnpm -r typecheck` across the workspace, and verify both pass
- [ ] 4.2 Deploy, save the working key on Settings > Configuration > Secrets for `core`, and verify with the one-off check in the pod that a text-generation call succeeds and a voice session opens, without a restart
