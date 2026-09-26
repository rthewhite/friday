# Tasks

## 1. Components

- [x] 1.1 Add `Icon` (inline SVG map: mic, grid, play, settings, key, refresh, plus, close, chevron; text fallback), `StatusDot`, `Chip`, and `Tabs` (pill group with counts, v-model) to `portal-ui`; verify component tests render each and `Tabs` emits on click
- [x] 1.2 Replace `Table` with `DataTable` (typed columns with width/align, sticky header, hover, `clickable` + `row-click`, cell and actions slots, responsive column hiding via `hideBelow`); verify tests cover row click and slot rendering, and existing MediaPage still builds
- [x] 1.3 Add `Drawer` (right panel, overlay, Escape/overlay close, title and footer slots) and an `eyebrow` prop on `PageLayout`; verify a test renders the drawer open and closed and the eyebrow text

## 2. API

- [x] 2.1 Change `configListing` to one entry per key with `modules`, aggregated `required`, `description`, `scope`, `updatedAt` (add `updated_at` to `ConfigStore.keys()` and a `updatedAt(scope,key)` lookup); verify tests for shared key across two modules, undeclared global, and updatedAt presence

## 3. Pages

- [x] 3.1 Sidebar: sections Assistant, Modules, System with uppercase labels, brand mark, `Icon` for items, module UI icons via name or text; verify screenshot at 1280 and the collapsed menu at 360 still works
- [x] 3.2 Configuration page: `Tabs` with counts, `DataTable` per tab, row drawer (value, scope, Save, Save and reload, Clear), header "Add value"/"Add secret" opening the drawer with a key field, `?key=` deep link; verify manually: edit a plain value, set a pending secret with reload, add a global, deep link opens the drawer
- [x] 3.3 Remote modules page: `DataTable` of keys with status dot, `New key` header action opening a drawer that shows the created key once with copy, `Revoke` row action; verify manually by creating and revoking a key
- [x] 3.4 Modules page: `DataTable` rows with status dot, kind, tool count, Open/Reload actions, and a details drawer; verify manually with one failed module and the reload flow

## 4. Docs and check

- [x] 4.1 Update `packages/portal-ui/README.md` (new components, page anatomy) and README's "Add a module UI" for `nav.icon` names; verify `openspec validate --all` passes
- [ ] 4.2 Deploy and compare against the Jarvis reference: Configuration table with requested-by chips, tabs with counts, drawer editing; verify screenshots attached to the commit message or PR
