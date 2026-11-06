# Portal Shell

## Purpose

The browser portal for Friday: a single-page application served by core that hosts the voice client, lists modules, and mounts screens contributed by modules through a build-time discovered UI contract with shared design tokens.

## Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row, three sections labelled `Assistant`, `Modules` and `System`, and a user menu. `Assistant` SHALL contain `Talk`, `Chat`, `Conversations` and `Agents`. `Modules` SHALL contain one entry per enabled module UI that is available to the user (`available` in `/api/modules`), ordered by `nav.order` then label, and SHALL be left out when there is none. `System` SHALL contain the pages listed in "Settings section" and SHALL be shown only to admins. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted. `Chat` SHALL be highlighted on `/chat` and on every `/chat/<id>`, and `Agents` on `/agents` and every route under it.

From 768 px wide the sidebar SHALL be a column beside the page that stays in view while the page scrolls. Below 768 px, down to 360 px, the sidebar SHALL be replaced by a top bar with the brand and a menu button that stays at the top of the screen while the page scrolls. The menu button SHALL open the navigation as a panel that slides in from the left over the page, in view wherever the page is scrolled to, with a backdrop over the rest of the page and a close button. While the panel is open the page behind it SHALL NOT scroll. The panel SHALL close when the user chooses an item, taps the backdrop, presses the close button or presses Escape, and closing it SHALL leave the page at the scroll position it had. Opening the panel SHALL move the focus into it, and closing it SHALL return the focus to the menu button. The menu button SHALL report whether the panel is open to assistive technology. When reduced motion is requested, the panel SHALL appear without sliding.

#### Scenario: Default navigation
- **WHEN** an admin loads the portal with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk`, `Chat`, `Conversations` and `Agents` under Assistant, `Media` under Modules, and the Settings section's pages, starting with `Modules`, under System

#### Scenario: Member navigation
- **WHEN** a member loads the portal
- **THEN** the sidebar shows Assistant and the module UIs available to them under Modules, and no System section

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not available" page

#### Scenario: Disabled module page
- **WHEN** a user opens `/m/sonos` while `sonos` is disabled
- **THEN** the page says the module is turned off for this Friday and does not mention an environment variable; an admin also gets a link to `/settings/modules`, a member does not

#### Scenario: Module not available to the user
- **WHEN** a user opens `/m/sonos` while `sonos` is not available to them
- **THEN** no `Sonos` nav item is shown, and the page says the module isn't available to them and to ask an admin, without saying who may use it

#### Scenario: No module UIs enabled
- **WHEN** every module that declares a UI is disabled or failed
- **THEN** the sidebar has no `Modules` section

#### Scenario: Chat thread highlighted
- **WHEN** the user is on `/chat/<id>`
- **THEN** the `Chat` item is highlighted

#### Scenario: Agent page highlighted
- **WHEN** the user is on an agent's page under `/agents`
- **THEN** the `Agents` item is highlighted

#### Scenario: Open the menu while scrolled down on a phone
- **WHEN** the user has scrolled halfway down the Conversations page on a 390 px wide screen and taps the menu button
- **THEN** the navigation slides in from the left over the page, fully in view, with the page dimmed behind it, and the page does not move

#### Scenario: Choose an item from the menu
- **WHEN** the menu panel is open and the user taps `Chat`
- **THEN** the panel closes and the Chat page is shown

#### Scenario: Dismiss the menu
- **WHEN** the menu panel is open and the user taps the backdrop, the close button or presses Escape
- **THEN** the panel closes, the page is at the scroll position it had before, and the focus is on the menu button

#### Scenario: Page behind the menu doesn't scroll
- **WHEN** the menu panel is open and the user swipes over it or the backdrop
- **THEN** the page behind it does not scroll

#### Scenario: Desktop sidebar unchanged
- **WHEN** the portal is shown 1280 px wide
- **THEN** the sidebar is a column on the left beside the page, with no top bar and no menu button

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

The Modules page SHALL be served at `/settings/modules`, and `/modules` SHALL redirect there. It SHALL list every entry from `/api/modules` as one table row with status dot, label, kind (core, in-process, MCP server, remote), tool count, and actions: `Open` when the module has a UI and is loaded, `Reload` for in-process modules that are not disabled, and an enable/disable switch for in-process modules. The `core` entry SHALL be shown with kind `core`. A row whose module has an access setting other than the default SHALL show who may use it: `Chosen users` for `mode: chosen`, or `Some tools restricted` when tools are restricted. Clicking a row SHALL open a drawer showing description, full tool list, error if failed, connection time for remotes, and the same switch for in-process modules. It SHALL refresh when re-opened and offer a `Refresh` header action.

Turning a switch off SHALL ask for confirmation, saying that the module's tools, pages and jobs stop and that its data and settings are kept. Turning a switch on SHALL need no confirmation. The switch SHALL call `PUT /api/modules/:id/enabled` and update the row, and the sidebar, with the returned entry, showing the error when the module failed to start. A request that fails SHALL leave the switch in its previous position and show the error.

The drawer SHALL have an **Access** section for every entry that has `access` (every kind except `core` and `builtin`), with:
- **Who may use it:** a choice between `Everyone` and `Chosen users`.
- **Chosen users:** a list of the users from `GET /api/users`. The household owner is shown as always included and can't be unticked. Disabled users are shown as disabled.
- **Restricted tools:** a checkbox per tool, meaning only the chosen users get it, and a field for patterns with `*`. This section SHALL be shown only for `Everyone`. Tools matched by a pattern SHALL show as restricted.
- **New tools:** a tool that is not in `knownTools` SHALL be marked new, so an admin notices tools that appeared since the access was last saved.
- **Saving:** `Save` SHALL call `PUT /api/modules/:id/access`, and `Reset to everyone` SHALL call `DELETE /api/modules/:id/access`. Both SHALL update the row with the returned entry. A request that fails SHALL keep the drawer's edits and show the error.

#### Scenario: Listing
- **WHEN** the page opens
- **THEN** each module is a row with its status dot, kind and tool count, and in-process rows have a switch that is on unless the module is disabled

#### Scenario: Details
- **WHEN** the user clicks the `media` row
- **THEN** a drawer lists its tools and description

#### Scenario: Core's tools
- **WHEN** the page opens and `/api/modules` has a `core` entry with the timer tools
- **THEN** a `Core` row with kind `core` and its tool count is listed, and its drawer lists `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert`

#### Scenario: Old address
- **WHEN** the user opens `/modules`
- **THEN** the portal shows `/settings/modules`

#### Scenario: Disable a module
- **WHEN** the user turns off the switch on the `sonos` row and confirms
- **THEN** the row shows `disabled` with no tools and no `Reload`, and the sidebar no longer shows a `Sonos` entry if it had one

#### Scenario: Cancel a disable
- **WHEN** the user turns off a switch and cancels the confirmation
- **THEN** no request is sent and the switch stays on

#### Scenario: Enable fails
- **WHEN** the user turns on the switch of `media` without its configuration
- **THEN** the switch is on and the row shows `failed` with the error

#### Scenario: No switch for other kinds
- **WHEN** the page lists `core`, an MCP server and a remote module
- **THEN** none of their rows or drawers offers a switch

#### Scenario: Restrict Home Assistant tools
- **WHEN** the admin opens the `mcp:HomeAssistant` drawer, keeps `Everyone`, ticks Raymond as chosen user, ticks `HomeAssistant__restart_ha`, adds the pattern `HomeAssistant__*delete*` and saves
- **THEN** `PUT /api/modules/mcp:HomeAssistant/access` is sent with those values, and the row shows `Some tools restricted`

#### Scenario: New tool marked
- **WHEN** Home Assistant gained `HomeAssistant__wipe_history` after its access was saved
- **THEN** the drawer marks `HomeAssistant__wipe_history` as new

#### Scenario: No access section for core
- **WHEN** the admin opens the `Core` or `Builtin` drawer
- **THEN** there is no Access section

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

The sidebar's `System` section SHALL contain `Modules`, `Configuration`, `Connections`, `Voice devices`, `Alerts`, `Remote modules`, `Jobs` and `Users`, routing to `/settings/modules`, `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys`, `/settings/jobs` and `/settings/users`. A member who opens a route under `/settings/` SHALL see a page saying it is for admins only.

#### Scenario: Navigation
- **WHEN** an admin loads the portal
- **THEN** `System` shows all eight pages and they route to `/settings/modules`, `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys`, `/settings/jobs` and `/settings/users`

#### Scenario: Member opens a settings URL
- **WHEN** a member opens `/settings/config` or `/settings/modules` directly
- **THEN** the portal shows that the page is for admins only and requests no configuration

### Requirement: Reload action on the Modules page

Each in-process module row that is not disabled SHALL offer a `Reload` action calling `POST /api/modules/:id/reload` and refreshing the row. Disabled rows, remote and MCP rows, and the `core` row SHALL show no reload action.

#### Scenario: Reload from the list
- **WHEN** the user clicks `Reload` on a failed module whose config is now set
- **THEN** the row updates to `loaded` with its tool count

#### Scenario: Core can't be reloaded
- **WHEN** the page lists the `core` row
- **THEN** neither the row nor its drawer offers `Reload`

#### Scenario: Disabled module can't be reloaded
- **WHEN** the page lists a disabled `sonos` row
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

### Requirement: Mobile layout

Every page of the shell, and every module page built from the shared components, SHALL fit a screen 360 px wide without the page scrolling sideways; wide content such as a table or a code block SHALL scroll inside its own box. On a touch screen, text inputs, text areas and selects SHALL use at least 16 px text, so that focusing one does not zoom the page. The portal SHALL NOT stop the user from zooming with a pinch. A page header's actions SHALL wrap below the title when they do not fit beside it, and a row of tabs that does not fit SHALL scroll sideways. On a screen with a notch, rounded corners or a home indicator, the top bar, the menu panel and drawers SHALL keep their content clear of them. From 768 px wide on a screen with a mouse or trackpad, the portal SHALL look as it did before this requirement.

#### Scenario: Narrow screen
- **WHEN** an admin opens each page under Assistant, Modules and System on a 360 px wide screen
- **THEN** none of them scrolls sideways

#### Scenario: Focus a field on a phone
- **WHEN** the user taps a text field on the Configuration page on an iPhone
- **THEN** the page does not zoom in

#### Scenario: Pinch zoom
- **WHEN** the user pinches to zoom on any page
- **THEN** the page zooms

#### Scenario: Header actions on a phone
- **WHEN** a page with a title and two actions is shown 360 px wide
- **THEN** the actions are shown below the title and both are fully visible

#### Scenario: Installed on an iPhone with a home indicator
- **WHEN** the portal runs as an installed app on an iPhone and the user opens a drawer
- **THEN** the drawer's buttons are above the home indicator and the top bar is below the status bar

#### Scenario: Desktop unchanged
- **WHEN** a page is shown 1280 px wide in a desktop browser
- **THEN** its text sizes, spacing and layout are the same as before this change

### Requirement: Installable app

The portal SHALL be installable as an app. It SHALL serve a web app manifest at `/manifest.webmanifest`, linked from every page, naming the app `Friday`, starting at `/`, with scope `/`, shown standalone, with the portal's background colour as background and theme colour, and with icons of 192 and 512 px, a 512 px maskable icon, a home-screen icon for iOS and a favicon. Pages SHALL declare the theme colour and the iOS app title `Friday`. The manifest, icons and favicon SHALL be served without a session, so the browser can read them before the user logs in. The installed app SHALL log in the same way the portal does in a browser.

#### Scenario: Install on Android
- **WHEN** the user opens the deployed portal in Chrome on Android
- **THEN** the browser offers to install `Friday`, and the installed app opens at `/` without a browser bar

#### Scenario: Add to the iOS home screen
- **WHEN** the user adds the portal to the home screen from Safari on an iPhone
- **THEN** the home screen shows the Friday icon named `Friday`, and it opens without the Safari bars

#### Scenario: Manifest without a session
- **WHEN** a request without a session asks for `/manifest.webmanifest`
- **THEN** it is answered with the manifest, typed `application/manifest+json`

#### Scenario: Log in from the installed app
- **WHEN** the installed app is opened without a session
- **THEN** the user is sent to the login and comes back to the app, logged in

### Requirement: Offline page

In a build for deployment, the portal SHALL register a service worker at `/sw.js` with scope `/` when the browser supports it. The service worker SHALL answer a page navigation from the network, and SHALL answer it with an offline page only when the network request fails. The offline page SHALL say that Friday can't be reached and offer `Retry`, which loads the page that was asked for again. The service worker SHALL NOT answer from a cache, nor store, any other request: the portal's code and styles, `/api`, `/auth`, `/ws` and `/health` SHALL always go to the network, so a deploy takes effect as before and "Recover from code replaced by a deploy" keeps working. Navigations under `/auth` SHALL be left to the browser entirely. `/sw.js` SHALL be served without a session and revalidated on every load, and a new version of it SHALL take over at the next page load. A failure to register SHALL be logged and SHALL NOT stop the portal from loading. The development server SHALL NOT register it.

#### Scenario: Server unreachable
- **WHEN** the installed app is opened while the server can't be reached
- **THEN** the offline page is shown saying Friday can't be reached, and `Retry` loads the portal once the server is back

#### Scenario: Server reachable
- **WHEN** the user opens `/chat` while the server is reachable
- **THEN** the page comes from the network, and nothing of it is stored by the service worker

#### Scenario: API request offline
- **WHEN** the portal requests `/api/modules` while the server can't be reached
- **THEN** the request fails as it would without a service worker, and no offline page is returned for it

#### Scenario: Deploy picked up
- **WHEN** a deploy replaces the portal's code while a tab with the service worker is open, and the tab then opens a page whose old code is gone
- **THEN** the portal reloads once at that page and shows it from the new build, as without a service worker

#### Scenario: Login not intercepted
- **WHEN** the portal sends the user to `/auth/login`
- **THEN** the service worker does not answer the navigation, and the login proceeds as without it

#### Scenario: Registration fails
- **WHEN** registering the service worker fails
- **THEN** the error is logged in the console and the portal works as before
