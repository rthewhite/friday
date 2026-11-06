# Proposal

## Why

On a phone the portal is awkward to use. The menu opens as a block at the top of the page, so when you are scrolled down you have to scroll back up to see it. On the Chat page, focusing the message box zooms the page in (the field's text is 14 px, and iOS zooms into anything below 16 px), the on-screen keyboard pushes the header out of view, and the `Send` button is a different height from the box next to it. Friday is also used from the phone often enough that it should be installable as an app on the home screen, without a browser bar. The desktop layout works well and must stay as it is.

## What Changes

- **Menu slides over the page.** Below 768 px the sidebar becomes a panel that slides in from the left over the page, wherever the page is scrolled to, with a backdrop. It closes on choosing an item, tapping the backdrop, a close button or Escape, and the page behind it does not scroll while it is open. The top bar with the menu button stays at the top.
- **Chat on a phone.** No zoom when the message box is focused. The message box and button stay just above the on-screen keyboard, with the page header still visible. The send button is a round icon button as tall as the message box, and the box grows with what you type. The thread list slides over the thread the same way the menu does. The Enter key still sends, and the keyboard's return key says so.
- **Mobile polish across pages.** Shared components are fixed once for every page, module pages included: form fields are 16 px on touch screens, page headers wrap their actions, tabs scroll sideways instead of overflowing, drawers and the top bar keep clear of the notch and home indicator, and no page scrolls sideways at 360 px. Pinch zoom stays possible.
- **Installable app (PWA).** A web app manifest, app icons, a favicon, theme colour and the iOS home-screen tags, so the portal can be installed on Android, iOS and desktop browsers and opens standalone. A small service worker shows a "Friday can't be reached" page with a Retry button when the server is unreachable. It never caches the portal's code or the API, so a deploy is picked up as before and the recovery from replaced code keeps working.
- **Desktop unchanged.** Everything above applies below 768 px or on touch screens only, except the manifest, icons and service worker, which change nothing you can see on the desktop page.

## Capabilities

### New Capabilities

None. The app install and the service worker are part of the portal shell.

### Modified Capabilities

- `portal-shell`: the narrow-screen menu slides over the page instead of pushing it down ("Shell layout and navigation"), plus new requirements for the mobile layout of shell and shared components, and for installing the portal as an app with an offline page.
- `portal-chat`: the Chat page's behaviour on a phone: no zoom on focus, composer above the keyboard, the send button's size, and the thread list as a panel over the thread ("Chat page").

## Impact

- `packages/portal`: `index.html` (viewport, manifest, icons, theme colour, iOS tags); `public/` gains `manifest.webmanifest`, icons, `favicon.svg`, `sw.js` and `offline.html`; a one-off icon generator script; `src/main.ts` registers the service worker; `src/shell/Shell.vue` and `Sidebar.vue` (slide-over menu); `src/pages/ChatPage.vue` (composer, thread panel, viewport height); a new slide-over component and small composables (media query, visual viewport).
- `packages/portal-ui`: `tokens.css` (16 px fields on touch screens, text size adjust, safe-area helpers), `PageLayout.vue`, `Tabs.vue`, `Drawer.vue`. No API change; module pages pick up the fixes.
- `packages/core`: no behaviour change. Core already serves the portal's files without a session, with `no-cache` outside `/assets/` and the `.webmanifest` type; a test pins this down for `sw.js` and the manifest.
- No new dependencies, no migration, no configuration. The service worker needs HTTPS (or localhost), which the deployed portal already has.
- Does not overlap with the in-flight `document-store` and `per-user-calendars` changes (neither touches the shell, Chat page or `portal-ui`).
