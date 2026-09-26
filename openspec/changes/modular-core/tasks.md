# Tasks

## 1. Workspace scaffolding

- [x] 1.1 Add `pnpm-workspace.yaml` (`packages/*`, `modules/*`), root `package.json` with `-r` scripts (`build`, `test`, `typecheck`, `dev`), root `tsconfig.base.json`, and `packageManager` pin; verify `pnpm install` succeeds and produces `pnpm-lock.yaml`
- [x] 1.2 Create `packages/sdk`, `packages/core`, `modules/builtin`, `modules/media` with `package.json`, `tsconfig.json` extending the base, and empty `src/`; verify `pnpm -r typecheck` passes on the empty packages
- [x] 1.3 Remove `package-lock.json`, update `.gitignore`/`.dockerignore` for per-package `dist/`; verify `git status` shows no stray build output after `pnpm -r build`

## 2. SDK contract and test host

- [x] 2.1 Move `Tool`, `ToolResult`, `Scheduling` and the Gemini `Schema` structural type into `packages/sdk/src/tool.ts`; verify the sdk has no runtime dependency on `@google/genai` (`pnpm why` shows none)
- [x] 2.2 Add `ModuleManifest`, `ConfigKey`, `ModuleContext`, `FridayModule`, `defineModule` in `packages/sdk/src/module.ts` and export from the package index; verify a sample module in a test type-checks against it
- [x] 2.3 Implement `ToolRegistry` in `packages/sdk/src/registry.ts` (`add`, `removeOwner`, `declarations`, `callTool` with `scheduling` and `endConversation` reserved keys, `onChange`, `list`); verify unit tests cover duplicate names, owner removal count, change listener unsubscribe, both reserved keys stripped, unknown tool, handler throw
- [x] 2.4 Implement `createTestHost` under the `@friday/sdk/test` export (in-memory registry, `env` config source, required-key validation); verify a test shows a module's tool callable with no server and that a missing required key rejects

## 3. Module host in core

- [x] 3.1 Move `src/` into `packages/core/src` and `test/` into `packages/core/test`, fixing imports to `@friday/sdk` for tool types; verify `pnpm --filter @friday/core test` passes with the existing `ws.test.ts`
- [x] 3.2 Implement `ModuleHost` (`load`, `loaded`, `dispose`) with `FRIDAY_MODULES` filtering, required config validation, failure isolation with tool rollback via `removeOwner`, prefixed `ctx.log`; verify tests cover default load, subset, unknown id warning, init throw rollback, reverse-order dispose
- [x] 3.3 Create the registry in `server.ts`, pass it to `GeminiSession` via the session factory, and snapshot `declarations()` in `open()`; verify a test opens a stub session, adds a tool, and confirms only the next session sees it
- [x] 3.4 Replace the `END_CONVERSATION` import in `session.ts` with handling of `endConversation` from `callTool`; verify the existing end-of-conversation tests pass and `grep -r "tools/builtin" packages/core/src` returns nothing
- [x] 3.5 Convert `mcp.ts` to register through `registry.add("mcp:<server>", tool)` and use `removeOwner` in `closeMcp`; verify the MCP tests (or a stubbed client test) still pass and `/api/modules` shows `mcp:<server>` entries
- [x] 3.6 Add `packages/core/src/modules.ts` with the static list and `GET /api/modules` in `server.ts`; verify a request returns `loaded`/`failed`/`disabled` statuses per spec scenarios
- [x] 3.7 Resolve the `web/` directory via `FRIDAY_WEB_DIR` defaulting to the repo `web/` relative to the core package; verify `curl /` returns `index.html` from `pnpm dev` and from the built `dist`

## 4. Builtin and media modules

- [x] 4.1 Create `modules/builtin` exporting a `defineModule` with `get_current_time`, `set_timer`, `end_conversation` (returning `endConversation: reason`); verify tests via `createTestHost` cover the three tools per the builtin-tools spec
- [x] 4.2 Create `modules/media` moving `media.ts` and `ha.ts`, declaring `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_USER`, `JELLYFIN_PUBLIC_URL`, `HA_URL`, `HA_TOKEN`, `HA_APPLE_TV_ENTITY` as config keys read through `ctx.config`; verify `grep process.env modules/media/src` is empty and a test host with a fetch stub exercises `search_library`
- [x] 4.3 Register both modules in core's list and delete the old `src/tools/builtin.ts`, `media.ts`, `ha.ts`, `loadTools`; verify `pnpm -r test` and `pnpm -r typecheck` pass and `/api/tools` lists the same tool names as before the change

## 5. Build, deploy, docs

- [x] 5.1 Rewrite `Dockerfile` for pnpm (`corepack enable`, frozen install, `pnpm -r build`, `pnpm --filter @friday/core deploy --prod`), copying `web/`; verify `docker build` succeeds and `docker run` answers `/health` and `/api/modules`
- [ ] 5.2 Update `.github/workflows/deploy.yml` test job to install pnpm and run `pnpm -r typecheck && pnpm -r test`; verify the workflow passes on a branch push
- [x] 5.3 Update `README.md` ("Add a tool" becomes "Add a module"), add `packages/sdk/README.md` describing the contract and test host, document `FRIDAY_MODULES` and `FRIDAY_WEB_DIR` in `.env.example`; verify the documented commands run as written
- [x] 5.4 Update `openspec/config.yaml` context to describe the workspace layout and module contract; verify `openspec validate --all` passes

## 6. Integration check

- [ ] 6.1 Run the server locally with a real `GEMINI_API_KEY`, complete a voice turn from the web client using `get_current_time`, `set_timer` and `end_conversation`, and one media tool; verify behaviour matches pre-change and the startup log lists modules with their tools
