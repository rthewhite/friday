# Proposal

## Why

Friday's browser client is one HTML page that only talks. The module system needs a home in the browser: a portal where each module can add its own screens (configuration, browsing its data) and where platform features like secrets and API keys will live. Today there is no frontend build, no routing and no way for a module to contribute UI.

## What Changes

- Add `packages/portal`: a Vue 3 single-page app built with Vite and Tailwind, served by core at `/`. It has a sidebar navigation, a `Talk` page that replaces the current `web/index.html` client with identical behaviour, and a `Modules` page listing what `/api/modules` reports.
- Modules can contribute UI. A module package declares a `ui` entry (Vue routes and a nav item) that the portal picks up at **build time** through a generated module list. Only UIs of modules that core reports as loaded are shown. No microfrontend runtime: one Vite build, shared Vue and design tokens.
- Modules can add backend routes. `ModuleContext` gains `http.route(method, path, handler)`, mounted under `/api/modules/<id>/`, so a module UI can talk to its own module.
- Design tokens and base components (`@friday/portal-ui`: layout, card, button, input, table) are shared so module pages look like the shell.
- The media module ships the first module page: library search and "play on Apple TV", exercising both the UI and route contracts.
- **BREAKING** `web/` is removed; core serves the built portal with SPA fallback. `FRIDAY_WEB_DIR` now points at the portal `dist`.
- Dev workflow: `pnpm dev` runs core and the Vite dev server with a proxy for `/api` and `/ws`.
- Dockerfile builds the portal and copies its `dist`.

## Capabilities

### New Capabilities
- `portal-shell`: the SPA shell (navigation, routing, Talk and Modules pages), the module UI contract and build-time discovery, shared design tokens, and the dev/build workflow.

### Modified Capabilities
- `module-system`: `ModuleContext.http.route` for module-scoped API routes; manifest gains the optional `ui` declaration.
- `http-server`: serves the portal build with SPA fallback instead of `web/`; mounts module routes under `/api/modules/<id>/`.
- `web-client`: the voice client becomes the portal's `Talk` page; behaviour requirements are kept, file-location requirements change.

## Impact

- Depends on `modular-core`. Independent of `remote-modules` (remote modules have no UI by design).
- New packages `packages/portal`, `packages/portal-ui`; new `ui/` subpath in `modules/media`; `web/` deleted; `Dockerfile`, CI, README, `.env.example` updated.
- New dependencies: `vue`, `vue-router`, `vite`, `@vitejs/plugin-vue`, `tailwindcss`, `@tailwindcss/vite`. Node 24 stays the runtime; the build stage gets longer.
- The Voice PE client is unaffected (WebSocket protocol unchanged).
