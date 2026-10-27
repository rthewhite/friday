## MODIFIED Requirements

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

## ADDED Requirements

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
