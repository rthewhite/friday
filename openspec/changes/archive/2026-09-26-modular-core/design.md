# Design

## Context

Friday today: one package, ~800 lines of server code, a global `Map` tool registry filled by side-effect imports (`loadTools()` hard-codes builtin, media, MCP), a `GeminiSession` that snapshots `declarations()` at `ai.live.connect`, and a session that imports `END_CONVERSATION` from the builtin tools to detect the ending tool. Integration config is read from `process.env` inside each tool file. Everything ships as one container built with `tsc`.

Constraints that shape the design:
- Gemini Live binds the tool list at session open. There is no mid-session update, so any dynamic tool set is observed by the *next* session.
- Later changes need: remote modules that appear and disappear at runtime (so tools must be removable as a group), a portal that lists modules and their UIs (so modules need an identity and manifest), and platform services handed to modules (so modules must receive a context object, not reach for globals).
- The Jarvis project shows the far end of this idea: modules as separate services with a registry, heartbeats and Module Federation. We deliberately want the contract without that machinery.

## Goals / Non-Goals

**Goals:**
- One module contract that an in-process package implements today and that a remote host can implement later without changing its shape.
- Core owns all shared state (registry, config, HTTP) and hands modules a context. Modules never import core.
- A module is testable alone: init it against a test host, call its tools, assert.
- Keep it one build and one image.

**Non-Goals:**
- Remote modules, WebSocket registration, API keys (change `remote-modules`).
- Portal shell, module UIs, any frontend build step (change `portal-shell`). `web/` stays as is.
- Secret storage or OAuth (change `platform-secrets`). `ctx.config` reads env vars for now.
- Hot reload of in-process modules. The in-process list is fixed at boot.

## Decisions

### D1. pnpm workspace with three package roots

```
friday/
+-- pnpm-workspace.yaml        packages/*, modules/*
+-- packages/sdk               @friday/sdk   contract + test host, no runtime deps
+-- packages/core              @friday/core  server; depends on sdk and on every in-process module
+-- modules/builtin            @friday/module-builtin
+-- modules/media              @friday/module-media   (ha.ts moves here; it is its only consumer)
+-- web/                       unchanged, served by core
```

Why pnpm: strict node_modules keeps modules from accidentally importing core; `workspace:*` deps; the user already runs it in Jarvis. Alternative considered: npm workspaces (hoisting hides missing deps) and a single package with folders (no isolation, nothing enforces the contract). Each package has its own `tsconfig.json` extending a root base; build is `pnpm -r build` with plain `tsc` (no bundler), matching current practice.

### D2. The contract lives in `@friday/sdk`

```ts
export interface ModuleManifest {
  id: string;                 // kebab-case, unique, used as tool owner and URL segment later
  label: string;
  description?: string;
  config?: ConfigKey[];       // { key, required?, description? } - env vars the module reads
}
export interface ModuleContext {
  defineTool<A>(tool: Tool<A>): Tool<A>;   // owner = manifest.id, applied by the host
  config: { get(key: string): string | undefined; require(key: string): string };
  log: Pick<Console, "log" | "warn" | "error">;   // prefixed with the module id
}
export interface FridayModule {
  manifest: ModuleManifest;
  init(ctx: ModuleContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
export const defineModule = (m: FridayModule) => m;
```

`Tool`, `ToolResult`, `Scheduling` move from `src/tools/index.ts` into the sdk unchanged. The sdk has no dependency on `@google/genai`; the Gemini `Schema` type is re-exported as a structural type so module authors get the same autocompletion as today. Alternative considered: passing the registry object itself to modules. Rejected because a remote host cannot hand over an in-process registry, and the context is where secrets/OAuth/routes will be added later.

Config keys are *declared* so core can validate at boot (`required` missing → module fails to load with a clear error, others continue) and so the portal can later show them as pending. `ctx.config` is backed by `process.env` in this change.

### D3. `ToolRegistry` becomes an instance with owners

```ts
class ToolRegistry {
  add(owner: string, tool: Tool): Tool           // throws duplicate tool <name>
  removeOwner(owner: string): number             // used by MCP shutdown now, remote modules later
  declarations(): FunctionDeclaration[]          // snapshot
  callTool(name, args): Promise<{ result, scheduling, endConversation? }>
  onChange(listener): () => void
  list(): { name, owner, description }[]
}
```

The registry is created in core's composition root (`server.ts`) and passed to the session factory and the module host. Tool names stay un-prefixed for in-process modules; a collision is a boot-time error as today. (Remote modules will get a prefix in their own change, because collisions there are runtime events.) Alternative: prefix every tool with its module id. Rejected: uglier names for Gemini, and builtin names like `set_timer` are part of the prompt.

`callTool` gains the second reserved key, `endConversation?: string`, resolved and stripped exactly like `scheduling`. The session acts on it instead of comparing the tool name to a constant. This removes `session.ts`'s import of `tools/builtin.ts`, the one place core knows a specific tool.

### D4. Module host and module list

`packages/core/src/modules.ts` exports the static list of in-process modules (imports of the workspace packages). `ModuleHost.load(modules, registry, env)`:

1. Filter by `FRIDAY_MODULES` (comma-separated ids) when set; otherwise load all.
2. For each module, in list order: validate declared `required` config, build a `ModuleContext` bound to the module id, `await init(ctx)`. A failure is logged with the module id and does not stop other modules or the server, mirroring today's MCP behaviour.
3. Expose `loaded(): { manifest, tools: string[], status: "loaded" | "failed", error? }[]` for `/api/modules` and the startup log.
4. `dispose()` in reverse order on shutdown.

The static list is a design choice, not a limitation: core depends on the module packages anyway for a single build, and the list is the one place to see what a deployment contains. Alternative considered: scanning `node_modules/@friday/module-*`. Rejected as magic that breaks under pnpm's strict layout and pruning.

### D5. MCP is a tool source, not a module

`mcp.ts` keeps its config file and behaviour but registers through `registry.add("mcp:<server>", tool)` and uses `removeOwner` on close. It is not wrapped in the module contract because it has no manifest, no config keys and no future UI. The remote-modules change reuses its MCP client code.

### D6. Testing

- `@friday/sdk/test` exports `createTestHost(module, { env })`: runs `init` against an in-memory registry and returns `{ tools, call(name, args), registry }`. Module packages test their tools with it and `node --test` (no framework change).
- Core keeps `test/ws.test.ts` and its `StubSession` harness; add tests for `ToolRegistry` (owner removal, change events, reserved keys) and `ModuleHost` (filtering, failure isolation, required config).
- `pnpm -r test` runs everything; CI's test job switches to it.

### D7. Build and deploy

Single multi-stage Dockerfile: `corepack enable`, copy lockfile and all `package.json`s, `pnpm install --frozen-lockfile`, copy sources, `pnpm -r build`, then `pnpm --filter @friday/core deploy --prod /out` to get a self-contained core with its workspace deps. Runtime stage copies `/out` and `web/`. Image count stays at one; k8s manifests unchanged except nothing.

## Risks / Trade-offs

- [Behaviour drift during the move] → Each existing spec (builtin-tools, media-playback, mcp-tools, audio-transport, voice-session) is unchanged in behaviour; tests are moved with the code and must pass before the old `src/` is deleted.
- [pnpm `deploy` and `tsc` output paths] → Verify the image starts in CI (`docker run --rm image node -e` smoke, plus `/health`) before merging; the current `WEB` path resolution relative to `dist/` needs a new anchor (`packages/core` → repo `web/`), decided in tasks by an explicit `FRIDAY_WEB_DIR` default.
- [Module init order dependencies] → Modules must not depend on each other's tools; the list order is only for deterministic logging. Documented in the sdk README.
- [Registry change events are unused until remote modules] → Keep the API tiny (`onChange`) so it is not speculative surface area; it is needed for the `/api/modules` log line and tests now.

## Open Questions

None that block this change. Deferred by design: prefixing rules for remote tools, how `ctx.config` maps to stored secrets, and module UI packaging.
