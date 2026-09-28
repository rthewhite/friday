# Design

## Context

`settings.apiKey` (`packages/core/src/config.ts`) is `process.env.GEMINI_API_KEY`, read at import. It's used by `GeminiSession.open()` (`new GoogleGenAI({ apiKey: settings.apiKey }).live.connect`), by `new GeminiTextModel(settings.apiKey)` in `server.ts` (which creates its client once), and by the startup warning. Module configuration already goes through `createResolver(store, env)(moduleId)` (`secrets/resolver.ts`): module scope, then `global`, then env, read live. `configListing` in `app.ts` builds entries from `host.manifests()`, `isDeclaredSecret` forces declared secrets to be encrypted, and `PUT /api/config/:scope/:key` accepts a loaded module id or `global`. `core` is already a reserved module id since `background-jobs`, so it can't collide with a module. See `proposal.md` for motivation.

## Goals / Non-Goals

**Goals:** One way to configure credentials, with core as a regular requester. A key change takes effect without a restart, and existing deployments keep working.

**Non-Goals:** Moving core's other settings, hot-swapping the key inside an open Live session, or validating a key when it's saved.

## Decisions

### Core is a requester with id `core`
`packages/core/src/core-config.ts` exports:
- `CORE_ID = "core"`
- `coreManifest`: `{ id: "core", label: "Core", config: [{ key: "GEMINI_API_KEY", secret: true, required: true, description: "Gemini API key for voice sessions and text generation" }] }`
- `coreConfig(store, env)`, which returns `createResolver(store, env)(CORE_ID)`

`configListing` and `isDeclaredSecret` iterate over `[{ manifest: coreManifest }, ...host.manifests()]`. The rest of the aggregation (shared keys, statuses, secret forcing) then applies to core unchanged. The PUT scope check accepts `core`.

*Alternative:* store the key under `global` only. Rejected, because every module's `ctx.config` could then read the Gemini key through the global fallback. The `core` scope keeps it private to core, and `global` still works if the user chooses it.

### Keys are passed as a function, read at use
A `geminiKey: () => string | undefined` is created once in `server.ts` from `coreConfig(...)`, and threaded through:
- `attachAudioWs(server, { geminiKey })` → `new GeminiSession(onEvent, registry, { geminiKey })`. `open()` resolves the key once per session and passes it to `connect(params, apiKey)`. The injectable `LiveConnect` gains the `apiKey` argument, so tests can assert which key was used.
- `new GeminiTextModel(geminiKey)` resolves the key on each `generate`. It caches one `GoogleGenAI` client per key value and replaces it when the value changes. An empty or undefined key still rejects with `unavailable: GEMINI_API_KEY is not configured`.

The default stays `() => settings.apiKey` wherever no function is passed, so tests and other callers behave as before. The store reads are small indexed SQLite lookups plus one AES-GCM decrypt, which is negligible next to a model call or a Live connect.

### Startup warning
`server.ts` replaces `if (!settings.apiKey)` with `if (!geminiKey()) console.warn("GEMINI_API_KEY is not set (Settings > Configuration > Secrets, or the environment)")`. `settings.apiKey` remains the env value, used only as the fallback default.

### Portal
In `ConfigurationPage.vue`:
- `canReload` excludes `core` as well as `global`.
- The scope option label for `core` reads "core only".
- When the draft scope is `core`, a hint under the actions says "Applies to the next voice session and model call."

No API shape changes are needed. The listing already carries `modules`, and core appears there as a requester.

## Risks / Trade-offs

- [The user saves a wrong key in the portal and it overrides a working env key] → The next session and call fail visibly with Gemini's error. `Clear` on the entry falls back to env immediately.
- [The master key is missing, so secrets are disabled] → The key can't be stored, and core keeps using env, as today. The Secrets tab already shows the disabled banner.
- [An open Live session keeps the old key] → Intended, per the spec scenario. Sessions are short.

## Migration Plan

No schema or data changes. Deploying changes nothing until a key is saved in the portal. After that, `GEMINI_API_KEY` in `friday-secrets` is only a fallback, and can be removed later. `infra/README.md` and `.env.example` are updated to say so. Rollback: redeploy the previous image. The key stored in the portal is then ignored, and env applies again.
