# Proposal

## Why

Core reads `GEMINI_API_KEY` once from the environment at startup, and in the homelab that means a hand-made Kubernetes secret (`friday-secrets`). Changing the key, for example to one from a project with billing, takes kubectl access, a secret edit and a pod restart. Modules already get their credentials from the portal's encrypted configuration store, read live, but core's own key bypasses it.

## What Changes

- Core declares its own configuration keys, the way modules do. For now that's one key: `GEMINI_API_KEY`, secret and required. Core's keys are listed in `/api/config` and on Settings > Configuration as requested by `core`.
- `core` becomes a configuration scope next to module ids and `global`, so the key can be stored for core only. Core resolves its keys in the order `core` scope, `global` scope, environment, which is the same lookup modules get.
- The key is resolved on use, not at startup: when each voice session opens, and on each `ctx.llm` call. A key saved in the portal applies to the next session and call, with no restart.
- The environment stays the fallback, so the existing `friday-secrets` deployment keeps working unchanged until a key is saved in the portal.
- On the Configuration page, a `core` key's drawer offers `Save` without a reload action, and says the value applies to the next session.
- `FRIDAY_MASTER_KEY` stays environment-only, because it encrypts the store itself. The startup warning about a missing Gemini key now looks at the resolved value.

Out of scope: moving core's other environment settings (models, timeouts, timezone, VAD) into the portal, and showing which key is active beyond the existing `set` / `env` / `pending` status.

## Capabilities

### New Capabilities

### Modified Capabilities
- `secret-management`: `core` as a requester and scope in the Configuration API, core's resolution order, core's declared keys, and the drawer for core keys.
- `voice-session`: the Live connection uses the Gemini key resolved when the session opens.
- `module-llm`: text generation uses the Gemini key resolved per call.

## Impact

- `packages/core/src`: a core config declaration and resolver (`config.ts` or `secrets/`), `app.ts` (listing and PUT scope), `session.ts` (key per session), `llm/gemini.ts` (key per call), `server.ts` (wiring and startup warning).
- `packages/portal`: `ConfigurationPage.vue` shows no reload for `core`.
- Docs: `infra/README.md` and `.env.example` say `GEMINI_API_KEY` can be set in the portal instead of `friday-secrets`.
