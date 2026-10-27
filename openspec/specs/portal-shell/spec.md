# Portal Shell

## Purpose

The browser portal for Friday: a single-page application served by core that hosts the voice client, lists modules, and mounts screens contributed by modules through a build-time discovered UI contract with shared design tokens.

## Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row, three sections labelled `Assistant`, `Modules` and `System`, and a user menu. `Assistant` SHALL contain `Talk`, `Chat`, `Conversations` and `Agents`. `Modules` SHALL contain the `Modules` page followed by one entry per enabled module UI, ordered by `nav.order` then label. `System` SHALL contain the pages listed in "Settings section" and SHALL be shown only to admins. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted. `Chat` SHALL be highlighted on `/chat` and on every `/chat/<id>`, and `Agents` on `/agents` and every route under it. The shell SHALL work at widths down to 360 px by collapsing the sidebar into a menu.

#### Scenario: Default navigation
- **WHEN** an admin loads the portal with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk`, `Chat`, `Conversations` and `Agents` under Assistant, `Modules` and `Media` under Modules, and the Settings section's pages under System

#### Scenario: Member navigation
- **WHEN** a member loads the portal
- **THEN** the sidebar shows Assistant and Modules, and no System section

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not enabled" page

#### Scenario: Chat thread highlighted
- **WHEN** the user is on `/chat/<id>`
- **THEN** the `Chat` item is highlighted

#### Scenario: Agent page highlighted
- **WHEN** the user is on an agent's page under `/agents`
- **THEN** the `Agents` item is highlighted

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

The `Modules` route SHALL list every entry from `/api/modules` as one table row with status dot, label, kind (core, in-process, MCP server, remote), tool count, and an action (`Open` when the module has a UI, `Reload` for in-process modules). The `core` entry SHALL be shown with kind `core`. Clicking a row SHALL open a drawer showing description, full tool list, error if failed, and connection time for remotes. It SHALL refresh when re-opened and offer a `Refresh` header action.

#### Scenario: Listing
- **WHEN** the page opens
- **THEN** each module is a row with its status dot, kind and tool count

#### Scenario: Details
- **WHEN** the user clicks the `media` row
- **THEN** a drawer lists its tools and description

#### Scenario: Core's tools
- **WHEN** the page opens and `/api/modules` has a `core` entry with the timer tools
- **THEN** a `Core` row with kind `core` and its tool count is listed, and its drawer lists `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert`

### Requirement: Shared design tokens and components

`@friday/portal-ui` SHALL export the CSS tokens and base components (page layout with eyebrow and actions, card, button, input, data table with row click, tabs with counts, status dot, chip, badge, drawer, icon) used by the shell, and module pages SHALL use them. Tailwind SHALL scan module UI sources so module pages are styled in the single portal build.

#### Scenario: Module page styling
- **WHEN** a module page uses `portal-ui` components and Tailwind classes
- **THEN** it renders with the same tokens as the shell without a module-specific CSS build

#### Scenario: Page anatomy
- **WHEN** a page sets `eyebrow="System"` and `title="Configuration"`
- **THEN** the eyebrow renders uppercase above the title with actions aligned to the right

### Requirement: Development workflow

`pnpm dev` SHALL start core and the Vite dev server, proxying `/api`, `/auth`, `/health` and `/ws` (including WebSocket upgrades) to core, with hot reload for shell and module UI sources. Without configured authentication, the proxied requests reach core from the local machine and are handled as the dev user (as specified in `user-auth`).

#### Scenario: Edit a module page
- **WHEN** a developer edits `modules/media/src/ui/MediaPage.vue`
- **THEN** the browser updates without a full reload and the Talk page's WebSocket still reaches core

#### Scenario: Dev without Authentik
- **WHEN** a developer runs `pnpm dev` without `FRIDAY_AUTH_ISSUER` and opens the portal
- **THEN** the portal loads as user `Dev` with role `admin`, without a login

### Requirement: Settings section

The sidebar's `System` section SHALL contain `Configuration`, `Connections`, `Voice devices`, `Alerts`, `Remote modules`, `Jobs` and `Users`, routing to `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys`, `/settings/jobs` and `/settings/users`. A member who opens a route under `/settings/` SHALL see a page saying it is for admins only.

#### Scenario: Navigation
- **WHEN** an admin loads the portal
- **THEN** `System` shows all seven pages and they route to `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys`, `/settings/jobs` and `/settings/users`

#### Scenario: Member opens a settings URL
- **WHEN** a member opens `/settings/config` directly
- **THEN** the portal shows that the page is for admins only and requests no configuration

### Requirement: Reload action on the Modules page

Each in-process module row SHALL offer a `Reload` action calling `POST /api/modules/:id/reload` and refreshing the row; remote and MCP rows, and the `core` row, SHALL show no reload action.

#### Scenario: Reload from the list
- **WHEN** the user clicks `Reload` on a failed module whose config is now set
- **THEN** the row updates to `loaded` with its tool count

#### Scenario: Core can't be reloaded
- **WHEN** the page lists the `core` row
- **THEN** neither the row nor its drawer offers `Reload`

### Requirement: Recover from code replaced by a deploy

When a navigation fails because the code of the target page cannot be loaded (the browser reports a failed dynamic import, or a page's stylesheet cannot be preloaded), the portal SHALL reload itself at the target route, so the current build is used. It SHALL reload for a given target at most once until a navigation succeeds again; a target that fails again after its reload SHALL be left to surface as an error, so a page that is really broken does not reload in a loop, however long the reload takes. When the browser does not allow the portal to record that reload, it SHALL NOT reload. Other navigation errors SHALL NOT cause a reload. Every navigation error that does not lead to a reload SHALL still be reported in the browser console. When the first page after loading the portal cannot be shown, the shell (sidebar and navigation) SHALL still be shown.

#### Scenario: Tab open across a deploy
- **WHEN** a tab loaded before a deploy navigates to `Chat`, whose old chunk no longer exists
- **THEN** the portal reloads at `/chat` and shows the Chat page from the new build

#### Scenario: Broken chunk
- **WHEN** the reloaded page's chunk fails to load again
- **THEN** the portal does not reload again, the error is reported in the console, and the sidebar is shown

#### Scenario: A later deploy
- **WHEN** a reload brought a tab to `/chat` successfully and a later deploy again replaces the Chat chunk under that tab
- **THEN** the next navigation to `Chat` reloads again

#### Scenario: Other errors
- **WHEN** a navigation fails for another reason, such as a guard throwing
- **THEN** the portal does not reload and the error is reported in the console

### Requirement: The portal knows its user before it renders

Before rendering the shell, the portal SHALL load `/api/me`. When that answers 401, the portal SHALL navigate the browser to `/auth/login?return_to=<the current path and query>`. When it answers with a user, the shell SHALL render for that user's role.

#### Scenario: Not logged in
- **WHEN** a browser without a session opens `/chat/abc`
- **THEN** it is sent to `/auth/login?return_to=/chat/abc`, and after logging in it lands on `/chat/abc`

#### Scenario: No flash of admin pages
- **WHEN** a member opens the portal
- **THEN** the System section is never rendered, not even briefly

### Requirement: An expired session sends the user to log in

When any API request of the portal or a module UI answers 401, the portal SHALL navigate the browser to `/auth/login` with the current path as `return_to`. A chat reply that is streaming SHALL finish first, and the Talk page SHALL do this only when its session is not connected. A 403 from an admin-only API SHALL be shown as an error on the page, not as a login.

#### Scenario: Session ended between requests
- **WHEN** the user's session has ended and they open the Conversations page
- **THEN** the browser goes to the login and comes back to the Conversations page

#### Scenario: Talk page refused
- **WHEN** the Talk page's WebSocket upgrade is refused with 401
- **THEN** the browser goes to the login and comes back to the Talk page

### Requirement: User menu

The sidebar SHALL end with a user menu showing the current user's name and role. It SHALL offer `Log out`, which posts `/auth/logout` and then shows a logged-out page with a link to log in again and, when the logout response holds the provider's end-session URL, a link to log out of Authentik too. Without configured authentication, the menu SHALL show the dev user and no `Log out`.

#### Scenario: Log out
- **WHEN** a user chooses `Log out`
- **THEN** their session ends and the logged-out page is shown

#### Scenario: Dev user
- **WHEN** the portal runs without configured authentication
- **THEN** the menu shows `Dev` and offers no `Log out`
