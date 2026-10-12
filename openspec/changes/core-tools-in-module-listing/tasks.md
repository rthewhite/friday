# Tasks

## 1. Core entry in the listing

- [ ] 1.1 Prepend the `core` entry in `moduleListing()` (`packages/core/src/app.ts`) from `registry.names("core")`, labelled from `coreManifest`, only when that list isn't empty. Verify with new cases in `packages/core/test/app.test.ts`: with core-owned tools the first entry is `core` (status `loaded`, those tools, `ui` false) followed by the modules; without them the listing is unchanged, and the existing `/api/modules` tests still pass
- [ ] 1.2 Mention the core entry in the README's `GET /api/modules` and Modules page sentences and in the `openspec/config.yaml` context, and verify `openspec validate core-tools-in-module-listing --strict` passes

## 2. Modules page

- [ ] 2.1 Move the row rules (status tone, kind, reloadable) from `ModulesPage.vue` into `packages/portal/src/lib/modules.ts`, with `core` as kind `built in` and never reloadable, and use them in the page. Verify with `packages/portal/test/modules.test.ts` covering core, in-process (loaded, failed, disabled), MCP and remote rows, plus `pnpm --filter @friday/portal test` and `pnpm --filter @friday/portal typecheck`

## 3. Check

- [ ] 3.1 Run core with a free port and verify `/api/modules` starts with the `core` entry listing the four timer tools, and that the Modules page shows a `Core` row with kind `built in`, its tools in the drawer and no `Reload`
