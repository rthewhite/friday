# Portal Shell

## Purpose

The browser portal for Friday: a single-page application served by core that hosts the voice client, lists modules, and mounts screens contributed by modules through a build-time discovered UI contract with shared design tokens.

## Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row and three sections labelled `Assistant`, `Modules` and `System`. `Assistant` SHALL contain `Talk` and `Conversations`; `Modules` SHALL contain the `Modules` page followed by one entry per enabled module UI ordered by `nav.order` then label; `System` SHALL contain `Configuration`, `Remote modules` and `Jobs`. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted. The shell SHALL work at widths down to 360 px by collapsing the sidebar into a menu.

#### Scenario: Default navigation
- **WHEN** the portal loads with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk` and `Conversations` under Assistant, `Modules` and `Media` under Modules, and `Configuration`, `Remote modules` and `Jobs` under System

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not enabled" page

### Requirement: Module UI contract

A module package MAY declare `"friday": { "ui": "<path>" }` in its `package.json`. The referenced file SHALL default-export `defineModuleUi({ id, nav: { label, icon?, order? }, routes })`, where `routes` are Vue Router route records relative to `/m/<id>`. The `id` SHALL equal the module manifest id.

#### Scenario: Module page reachable
- **WHEN** media declares a route with path `""`
- **THEN** navigating to `/m/media` renders that component inside the shell

#### Scenario: Nested route
- **WHEN** media declares a route `items/:id`
- **THEN** `/m/media/items/42` renders it with `id` = `42`

### Requirement: Build-time discovery of module UIs

A generator SHALL scan workspace packages for the `friday.ui` declaration before `dev` and `build` and write the import list the shell consumes. A declared path that does not resolve SHALL fail the build with the package name.

#### Scenario: New module with UI
- **WHEN** a new module package declares `friday.ui` and `pnpm build` runs
- **THEN** its routes and nav item are present in the built portal without shell code changes

#### Scenario: Broken declaration
- **WHEN** `friday.ui` points to a missing file
- **THEN** the build fails naming the package

### Requirement: Talk page

The `Talk` route SHALL provide the voice client with the behaviour specified in `web-client`, using the same `/ws/audio` protocol and an AudioWorklet served as a plain file.

#### Scenario: Voice session from the portal
- **WHEN** the user opens `/` and clicks `Start talking`
- **THEN** a session runs exactly as specified in `web-client`

### Requirement: Modules page

The `Modules` route SHALL list every entry from `/api/modules` as one table row with status dot, label, kind (in-process, MCP server, remote), tool count, and an action (`Open` when the module has a UI, `Reload` for in-process modules). Clicking a row SHALL open a drawer showing description, full tool list, error if failed, and connection time for remotes. It SHALL refresh when re-opened and offer a `Refresh` header action.

#### Scenario: Listing
- **WHEN** the page opens
- **THEN** each module is a row with its status dot, kind and tool count

#### Scenario: Details
- **WHEN** the user clicks the `media` row
- **THEN** a drawer lists its tools and description

### Requirement: Shared design tokens and components

`@friday/portal-ui` SHALL export the CSS tokens and base components (page layout with eyebrow and actions, card, button, input, data table with row click, tabs with counts, status dot, chip, badge, drawer, icon) used by the shell, and module pages SHALL use them. Tailwind SHALL scan module UI sources so module pages are styled in the single portal build.

#### Scenario: Module page styling
- **WHEN** a module page uses `portal-ui` components and Tailwind classes
- **THEN** it renders with the same tokens as the shell without a module-specific CSS build

#### Scenario: Page anatomy
- **WHEN** a page sets `eyebrow="System"` and `title="Configuration"`
- **THEN** the eyebrow renders uppercase above the title with actions aligned to the right

### Requirement: Development workflow

`pnpm dev` SHALL start core and the Vite dev server, proxying `/api`, `/health` and `/ws` (including WebSocket upgrades) to core, with hot reload for shell and module UI sources.

#### Scenario: Edit a module page
- **WHEN** a developer edits `modules/media/src/ui/MediaPage.vue`
- **THEN** the browser updates without a full reload and the Talk page's WebSocket still reaches core

### Requirement: Settings section

The sidebar's `System` section SHALL contain `Configuration` and `Remote modules`, routing to `/settings/config` and `/settings/keys`.

#### Scenario: Navigation
- **WHEN** the portal loads
- **THEN** `System` shows both pages and they route to `/settings/config` and `/settings/keys`

### Requirement: Reload action on the Modules page

Each in-process module row SHALL offer a `Reload` action calling `POST /api/modules/:id/reload` and refreshing the row; remote and MCP rows SHALL show no reload action.

#### Scenario: Reload from the list
- **WHEN** the user clicks `Reload` on a failed module whose config is now set
- **THEN** the row updates to `loaded` with its tool count
