# Tasks

## 1. Portal scaffolding

- [x] 1.1 Create `packages/portal` (Vue 3, Vite, vue-router, Tailwind 4) with an empty shell, `index.html`, and `dev`/`build` scripts; verify `pnpm --filter @friday/portal build` produces `dist/index.html`
- [x] 1.2 Create `packages/portal-ui` with tokens (`--f-*`, ported from Jarvis's preset), base components (PageLayout, Card, Button, Input, Table, Badge) and `defineModuleUi` types; verify a component test renders each and `pnpm -r typecheck` passes
- [x] 1.3 Configure Vite `server.proxy` for `/api`, `/health`, `/ws` (ws: true) and a root `pnpm dev` that runs core and Vite concurrently; verify `curl localhost:5173/api/modules` returns core's response and a WebSocket to `localhost:5173/ws/audio` upgrades

## 2. Core routing and static serving

- [x] 2.1 Implement a small path router (method, `:param` patterns, JSON body helper) and move `/health`, `/api/tools`, `/api/modules` onto it; verify router unit tests cover params, method mismatch, and 404
- [x] 2.2 Serve `FRIDAY_WEB_DIR` (default portal `dist`) with content types, hashed-asset caching, SPA fallback excluding `/api`, `/ws`, `/health`, and a traversal guard; verify tests for root, asset, SPA route, `/api/nope` 404, and `/../` 400
- [x] 2.3 Add `ctx.http.route` to the module host with per-module routers mounted at `/api/modules/<id>/`, removed on dispose/failure; verify tests for dispatch, params, unknown module 404, and removal after a failing init
- [x] 2.4 Add `ui` to the manifest and `/api/modules` output; verify the endpoint shows `ui: true` for a module that sets it

## 3. Shell features

- [x] 3.1 Build the sidebar layout with nav items, active highlighting and a collapsed menu under 768 px; verify visually at 360 px and 1280 px (screenshots attached to the PR)
- [x] 3.2 Implement the `Modules` page reading `/api/modules` with status badges, tool names and errors; verify against a core with one failing module
- [ ] 3.3 Port the voice client to `TalkPage.vue` + `useVoiceSession()` and move `capture-worklet.js` to `public/`; verify every `web-client` scenario manually (start, stop, start fails, gapless playback, interrupted, transcript roles, tool lines, server close drains, socket drop, navigate away) and record the checklist in the PR
- [x] 3.4 Implement `gen-modules.ts` (scan workspace for `friday.ui`, write `modules.gen.ts`, fail on unresolvable path) hooked to `predev`/`prebuild`, and route registration under `/m/<id>` with hidden nav and a "module not enabled" page; verify tests for the generator and a manual check that a disabled module's page shows the notice

## 4. First module UI

- [x] 4.1 Add `modules/media/src/ui` with `defineModuleUi` (nav `Media`, route `""` → `MediaPage.vue`), a `./ui` subpath export and `vue` peer dependency; verify the nav item appears after `pnpm build`
- [x] 4.2 Register `GET search?q=` and `POST play` module routes in media's `init` reusing the tool implementations; verify route tests through `createTestHost` extended with an `http` stub
- [ ] 4.3 Build `MediaPage.vue` (search box, results table, play button) with `portal-ui` components; verify a search returns Jellyfin results in the browser and play triggers the Apple TV via HA

## 5. Build, deploy, cleanup

- [x] 5.1 Update `Dockerfile` to build the portal and copy `packages/portal/dist`; update `FRIDAY_WEB_DIR` default resolution; verify `docker run` serves `/` and `/m/media`
- [x] 5.2 Delete `web/`, update `.dockerignore`, README (portal section, dev workflow, "Add a module UI"), `.env.example`, and `openspec/config.yaml` context; verify `openspec validate --all` and CI pass
- [ ] 5.3 Confirm the Voice PE still connects to the deployed server after the change; verify a wake-word session completes end to end

## 6. Integration check

- [ ] 6.1 From a fresh clone: `pnpm install && pnpm build && pnpm --filter @friday/core start`, open the portal, run a voice turn, open Modules and Media pages; verify all work with no console errors
