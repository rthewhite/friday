# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
