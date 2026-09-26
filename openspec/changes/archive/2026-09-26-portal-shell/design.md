# Design

## Context

After `modular-core`, core is a plain `node:http` server with hand-written routing that serves `web/` statically and exposes `/api/tools` and `/api/modules`. Modules are workspace packages compiled together into one image. The web client is 90 lines of vanilla JS plus an AudioWorklet and has behaviour specs (`web-client`) that must survive.

Jarvis solved the same need with Module Federation, a registry proxy and per-module Vite builds, because its modules are deployed separately. Here they are not, which removes the reason for a runtime microfrontend mechanism.

## Goals / Non-Goals

**Goals:**
- A module's UI lives in the module's package and is discovered by the shell without editing shell code.
- One frontend build, one set of shared dependencies and styles.
- Module UIs reach their backend through a module-scoped route namespace, without editing core routing.
- Keep the Talk page's behaviour and the Voice PE protocol untouched.

**Non-Goals:**
- Runtime-loaded remote UIs. If ever needed, an import-map remote can be added behind the same `ui` declaration.
- Authentication for the portal (LAN only; forward-auth later).
- Platform pages for secrets and keys (change `platform-secrets`, which adds pages using this shell).
- A PWA, offline support, or mobile-specific layout.

## Decisions

### D1. Vue 3 + Vite + Tailwind 4, tokens lifted from Jarvis

The user already runs this stack in Jarvis and its design tokens (`--j-*`, `.surface-card`) are known to work; we copy the token set into `packages/portal-ui/src/tokens.css` under a `--f-*` prefix and keep the same semantics. Alternative considered: stay framework-free with web components. Rejected because module authors would write raw DOM code for every config page; Vue SFCs are the productivity win the portal exists for.

### D2. Build-time module UI discovery

```
modules/media/package.json          "friday": { "ui": "./src/ui/index.ts" }
modules/media/src/ui/index.ts       export default defineModuleUi({ id: "media", nav: { label, icon, order }, routes: [{ path: "", component: () => import("./MediaPage.vue") }] })

packages/portal/scripts/gen-modules.ts   scans workspace packages for "friday.ui", writes
packages/portal/src/modules.gen.ts       export const moduleUis = [ () => import("@friday/module-media/ui"), ... ]
```

The generator runs in `predev` and `prebuild`. The shell registers each UI's routes under `/m/<id>/...`, and adds nav items. At runtime it fetches `/api/modules` and hides nav items whose module is not `loaded`; navigating to a hidden module shows a "module not enabled" page. Alternative considered: Module Federation. Rejected as documented in the proposal; the per-module CSS, singleton sharing and proxy complexity in Jarvis all stem from it.

`defineModuleUi` and its types live in `@friday/portal-ui` (Vue-dependent), not in `@friday/sdk` (no frontend deps). Module packages that ship UI get a `./ui` subpath export and `vue` as a peer dependency.

### D3. Module-scoped HTTP routes

`ModuleContext.http.route(method, path, handler)` registers `(req, res)` handlers on a per-module router that core mounts at `/api/modules/<id>/<path>`. Core replaces hand-written `if` routing with a tiny path router (own code, ~60 lines: method + path pattern with `:params`, JSON body helper). No Express: the server is small and already handles upgrades itself. Routes are removed with the module on dispose or failure, like tools. Remote modules get no routes.

### D4. Serving the portal

Core serves `FRIDAY_WEB_DIR` (default: `packages/portal/dist` resolved from the core package) with hashed asset caching and SPA fallback: any GET not under `/api`, `/ws`, `/health` and not matching a file returns `index.html`. Path traversal is rejected (the current static handler has no guard; fix it here). Alternative: serve the portal from a separate nginx like Jarvis. Rejected: one container, one process.

### D5. Talk page migration

`web/index.html`'s script becomes `TalkPage.vue` plus a `useVoiceSession()` composable; `capture-worklet.js` moves to `packages/portal/public/` so it stays a plain worklet file. Every `web-client` scenario is re-verified in the browser; the tests are manual today and remain so, listed in tasks.

### D6. Dev workflow

`pnpm dev` runs `tsx watch` for core on 8080 and Vite on 5173 with `server.proxy` for `/api`, `/health` and `/ws` (with `ws: true`). Module UI changes hot-reload through Vite because they are ordinary workspace imports.

## Risks / Trade-offs

- [Tailwind scanning module sources] → `@source "../../modules/*/src/ui"` in the portal CSS so classes used in module pages are generated; documented in `portal-ui` README.
- [Generated file drift] → `modules.gen.ts` is git-ignored and regenerated on every dev/build; CI fails if a declared `ui` path does not resolve.
- [Bigger image build] → Vite build adds ~30 s; acceptable. Runtime image only carries `dist`.
- [Microphone secure-context rule] → unchanged; the Traefik `websecure` route already gives HTTPS on the LAN.

## Open Questions

None blocking. Icon set (e.g. Lucide) and exact token values are implementation details left to the tasks.
