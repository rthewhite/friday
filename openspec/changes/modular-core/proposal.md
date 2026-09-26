# Proposal

## Why

Friday's tools, integrations and web client all live in one package with a hard-coded import list, so adding a feature means editing core, and nothing can be developed or tested on its own. We want Friday to become a small core that hosts modules: each module contributes tools (and later a portal UI and other features) through one contract, so features can be built and tested as separate packages. This change lays that foundation; remote modules, the portal and platform services (secrets, API keys) follow in later changes and depend on this contract.

## What Changes

- Convert the repo to a pnpm workspace monorepo: `packages/sdk` (module contract), `packages/core` (server), `modules/builtin`, `modules/media`. Still one build, one container.
- Introduce the module contract in `@friday/sdk`: a module exports a manifest (`id`, `label`, declared config keys) and an `init(ctx)` that receives a `ModuleContext` with `defineTool`, `config`, and `log`. Add a test host so a module can be exercised without booting core.
- **BREAKING** The tool registry becomes an instance owned by core rather than a module-level singleton. Tools are tagged with the module that owns them and can be removed as a group; each new voice session snapshots the current declarations. `loadTools()` and the fixed builtin → media → MCP loading order are removed.
- Core loads an explicit list of in-process modules and lets `FRIDAY_MODULES` narrow it, so a deployment can enable a subset.
- The voice session no longer imports the `end_conversation` tool directly. A tool result may carry a reserved `endConversation` key (stripped like `scheduling`) that asks the session to close; the builtin module uses it.
- MCP servers become a core-owned tool source (owner `mcp:<server>`), unchanged in behaviour.
- `/api/modules` returns the loaded modules and their tools, for the portal later.
- Move Jellyfin and Home Assistant configuration reads behind `ctx.config` with keys declared in the media module's manifest, replacing ad-hoc `process.env` reads.
- Dockerfile, CI workflow and README updated for the workspace layout. The web client in `web/` is untouched and still served by core.

## Capabilities

### New Capabilities
- `module-system`: the module contract, the in-process module host (discovery, init, enable/disable, config declaration) and the test host.

### Modified Capabilities
- `tool-registry`: registry becomes an instance with owner-tagged registration, removal by owner, change notification and per-session snapshots; the loading-order requirement is removed; `endConversation` becomes a reserved result key.
- `http-server`: startup loads modules and MCP sources instead of a fixed tool list; adds `/api/modules`.
- `voice-session`: end of conversation is triggered by the reserved `endConversation` result key rather than by the tool's name.
- `builtin-tools`: `end_conversation` signals the session through the reserved result key.

## Impact

- Every file under `src/` moves into a workspace package; `test/` moves alongside core. Import paths, `package.json` scripts, `tsconfig`, `Dockerfile`, `.github/workflows/deploy.yml` and `.dockerignore` change. `package-lock.json` is replaced by `pnpm-lock.yaml`.
- No runtime behaviour change for users: same tools, same WebSocket protocol, same web client, same env vars, same single image.
- New dependency: pnpm as the package manager (CI and Dockerfile).
- Downstream changes that build on this: `remote-modules`, `portal-shell`, `platform-secrets`.
