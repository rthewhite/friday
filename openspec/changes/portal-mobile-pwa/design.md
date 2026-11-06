# Design

## Context

What the code does today, on a phone (see proposal.md for why it matters):

- **Menu.** `Shell.vue` has a sticky `md:hidden` top bar with a `☰` button that toggles `hidden`/`block` on `Sidebar.vue`. The sidebar is in the normal flow, between the top bar and `<main>`, so opening it pushes the page down at the top of the document, out of view when scrolled.
- **Chat.** `ChatPage.vue` sizes itself `h-[calc(100dvh-3.5rem)]` below the top bar. The textarea is `text-sm` (14 px), which iOS zooms into on focus. iOS also does not shrink `dvh` for the on-screen keyboard: it pans the visual viewport instead, so the page header slides off the top. The composer is `items-end` with a 2-row `resize-y` textarea (≥ 48 px) next to a `Button` with icon and label (36 px, `rounded-full`), so the two don't line up. The thread list is an `absolute top-14` panel.
- **Shared components.** Most pages are `PageLayout` + `DataTable` + `Tabs` + `Drawer` from `@friday/portal-ui`, and module pages use the same ones. `DataTable` already scrolls inside its card and hides columns with `hideBelow`. `PageLayout`'s actions row doesn't wrap, `Tabs` is an `inline-flex` that can overflow at 360 px, and `Drawer` ignores safe areas. The body font is 14 px and every field is `text-sm`.
- **Serving.** Core serves `packages/portal/dist` without a session, with `no-cache` outside `/assets/`, SPA fallback only for extension-less paths, and already maps `.webmanifest` and `.png`. `stale-chunks.ts` reloads once when a chunk from a replaced build fails to load. The index has only `charset`, `viewport` and `title`: no favicon, manifest or theme colour.

## Goals / Non-Goals

**Goals:**
- Every change that is visible is scoped to below `md` (768 px) or to `(pointer: coarse)`, so the desktop page renders the same.
- Fix things once in shared components and tokens, so module pages get them without edits.
- An installable PWA that adds no caching of the portal's code or data.

**Non-Goals:**
- Offline use of Friday, background sync, or push notifications.
- A separate mobile navigation pattern (bottom tab bar), or page-specific redesigns beyond the Chat page.
- Changing the Talk page's voice behaviour.
- Pixel-level screenshot tests. Desktop parity is checked by hand (see Risks).

## Decisions

### 1. One slide-over component for the menu and the chat threads

A new `packages/portal/src/components/SlideOver.vue`: a `v-model:open` panel teleported to `body`, `fixed inset-y-0 left-0`, `w-72 max-w-[85vw]`, sliding in with a CSS transform transition (`motion-reduce:transition-none`), over a `bg-black/50` backdrop. It closes on backdrop click and Escape, moves focus to its first focusable element on open and back to the element that had it on close, and locks page scroll while open by setting `overflow: hidden` on `<html>` (restoring the previous value). It renders only below `md`: it has `md:hidden` on its root, so a stale `open` can't overlay the desktop.

`Shell.vue` keeps the desktop `<Sidebar>` as is (`hidden md:block` instead of the `open`-driven class), and renders a second `<Sidebar>` inside the `SlideOver` for phones, with the brand row and a close button. Closing on navigation stays the `watch(route.fullPath)` it has now. The menu button gets `aria-expanded` and `aria-controls`, and the `☰` text becomes the `menu` icon (added to portal-ui's `Icon` if it isn't there). `ChatPage.vue` puts its thread list in the same `SlideOver` below `md` and keeps the `md:flex` column above it.

*Alternatives:* extend portal-ui's `Drawer` with a `side` prop. Rejected: `Drawer` brings a titled header and padded body that neither the nav nor the thread list wants, and the menu needs focus return and scroll lock that `Drawer` doesn't have; mixing both would change `Drawer` for every module page. Keeping `SlideOver` in the portal (not portal-ui) keeps it out of the module contract until a module needs it.

Two `Sidebar` instances (one hidden by CSS) is simpler than moving one between a column and a teleported panel at a breakpoint, and keeps the desktop DOM identical.

### 2. 16 px fields on touch screens, unlayered

In `tokens.css`, outside any `@layer`:

```css
@media (pointer: coarse) {
  input:not([type="checkbox"], [type="radio"], [type="range"]), textarea, select { font-size: max(16px, 1em); }
}
```

Unlayered rules beat Tailwind v4's `@layer utilities`, so this wins over `text-sm` without touching any page. `(pointer: coarse)` covers phones and tablets (iPads zoom too) and leaves mouse/trackpad desktops alone. `html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }` goes in the base layer so landscape iOS doesn't inflate text.

*Alternative:* `maximum-scale=1` in the viewport. Rejected: it stops the zoom on iOS but disables pinch zoom on Android, which the spec keeps.

### 3. Viewport and safe areas

`index.html` viewport becomes `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. `viewport-fit=cover` lets the installed app draw under the status bar, and `env(safe-area-inset-*)` (0 on desktop) pads it back: the top bar gets `pt-[env(safe-area-inset-top)]` and its height becomes `calc(3.5rem + env(safe-area-inset-top))`, kept in one CSS variable `--f-topbar-h` that the Chat page uses. `SlideOver` and `Drawer` pad top and bottom with the insets, and the chat composer pads its bottom. `interactive-widget=resizes-content` makes Chrome on Android shrink the layout viewport (and so `dvh`) for the keyboard. iOS ignores it, see 4.

`Shell.vue`'s `min-h-screen` becomes `min-h-dvh`.

### 4. Chat height follows the visual viewport

A composable `useVisualViewportHeight()` (in `src/composables/`) writes `window.visualViewport.height` to `--f-viewport-h` on `<html>` on the viewport's `resize` and `scroll` events, and removes the listeners and the variable on unmount. The Chat page uses it below `md`: `height: calc(var(--f-viewport-h, 100dvh) - var(--f-topbar-h))`. When the iOS keyboard opens, the visual viewport shrinks, the page shrinks with it, and the composer sits on the keyboard. On resize it also calls `window.scrollTo(0, 0)` while the page fits the viewport, undoing the pan iOS does on focus, so the top bar stays visible. Where `visualViewport` is missing, the fallback `100dvh` is today's behaviour. The message list gets `overscroll-contain`, so scrolling to its end does not scroll the page or trigger pull-to-refresh.

*Alternative:* make the whole shell a fixed-height app frame with only `<main>` scrolling. Rejected: it changes scrolling on every page (and the desktop's sticky sidebar), for a problem only the Chat page has.

### 5. Composer below `md`

- Textarea: `rows` stays 2 for the desktop; below `md` it is one line (`max-md:min-h-11`, 44 px), grows with `max-md:[field-sizing:content]` up to `max-md:max-h-40`, and has no resize handle (`max-md:resize-none`). `field-sizing` is in Chrome 123+ and Safari 26; where it's missing the box stays one line and scrolls, which is acceptable.
- `enterkeyhint="send"` on the textarea; Enter still sends (spec unchanged on that point).
- Placeholder: a `useMediaQuery("(min-width: 768px)")` composable picks the current text on desktop and `Message Friday…` below `md`.
- Send button: the same `Button`, with `max-md:size-11 max-md:p-0 max-md:justify-center` and the label in `<span class="max-md:sr-only">Send</span>`, so its accessible name stays `Send` and the desktop button is unchanged. The row aligns `items-end`, so the 44 px button matches the one-line textarea and stays at its bottom as it grows.

### 6. Shared component fixes in portal-ui

- `PageLayout`: actions row gets `flex-wrap`; title `text-2xl md:text-3xl`. The header already `flex-wrap`s, so actions drop below the title when they don't fit.
- `Tabs`: root gets `max-w-full overflow-x-auto` and the buttons `shrink-0 whitespace-nowrap`; nothing changes while the tabs fit.
- `Drawer`: `h-dvh` and safe-area padding on header and footer.
- After these, an audit of every route at 360 px (task 5) fixes whatever page still scrolls sideways, in that page.

### 7. PWA: manifest, icons and a navigation-only service worker

- `public/manifest.webmanifest`: `name`/`short_name` `Friday`, `id`/`start_url`/`scope` `/`, `display: standalone`, `background_color` and `theme_color` `#0f1217` (`--color-f-bg`), icons `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png` (`purpose: maskable`).
- `index.html`: `<link rel="manifest">`, `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`, `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">` (180 px), `<meta name="theme-color" content="#0f1217">`, `<meta name="apple-mobile-web-app-title" content="Friday">`, `<meta name="mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`.
- Icons: the sidebar's brand mark (white `F` on an accent rounded square). `public/favicon.svg` is the source. The PNGs are made by `scripts/gen-icons.mjs`, which draws the mark (a rounded square and the `F` as three rectangles, with the maskable variant inside the 80% safe zone) into RGBA buffers and encodes PNG with `node:zlib`, with no dependency. It runs by hand, and its output is committed; build and CI don't run it.
- `public/sw.js`, plain JavaScript (Vite copies `public/` as is):
  - `install`: cache `/offline.html` in a versioned cache (`friday-offline-v1`), `skipWaiting()`.
  - `activate`: delete other `friday-*` caches, `clients.claim()`.
  - `fetch`: only when `request.mode === "navigate"`, same origin, and the path is not under `/auth`, `/api`, `/ws` or `/health`: `respondWith(fetch(request).catch(() => caches.match("/offline.html")))`. Every other request gets no `respondWith`, so the browser handles it as if there were no worker.
- `public/offline.html`: self-contained (inline styles in the portal's colours, no external files), "Friday can't be reached", `Retry` = `location.reload()`. Since the worker answers the navigation itself, the URL stays the one asked for, so a reload retries that page.
- `src/lib/pwa.ts`: `registerServiceWorker(nav, enabled)`, called from `main.ts` with `import.meta.env.PROD` after mount. It registers `/sw.js` with scope `/` when enabled and `serviceWorker` is in `navigator`, and logs a rejection with `console.warn`. Taking `navigator` as a parameter keeps it testable in `node:test`.

Because only failed navigations are answered, and from the network otherwise, the worker can't serve stale code: chunks, CSS and the index always come from the network, and `stale-chunks.ts` keeps working unchanged. Leaving `/auth` alone avoids opaque-redirect handling in the login flow.

*Alternatives:* manifest only, with no worker. Chrome no longer needs a fetch handler to install, and iOS never did, but an installed app would then show the browser's own offline error, which looks broken in a standalone window. A precaching worker (Workbox / `vite-plugin-pwa`) would make the shell load offline, but the portal is useless without core, it adds a dependency, and caching the index and chunks conflicts with the reload-after-deploy recovery. Rejected.

### 8. Tests

- `node:test`: `test/pwa.test.ts` reads `public/manifest.webmanifest` and checks its fields; checks each icon exists as a PNG with the stated size (from the IHDR chunk); checks `index.html` has the links and meta tags; loads `public/sw.js` in `node:vm` with a fake `self`, `caches` and `fetch`, and dispatches fake events (navigation online, navigation offline, `/api/...` offline, `/auth/login`, a `/assets/` script, cross-origin), asserting what gets `respondWith` and that nothing but the offline page is cached. `registerServiceWorker` gets its own cases (disabled, unsupported, rejection logged). `gen-icons.mjs` exports its PNG encoder so the test can decode a generated icon.
- vitest components: `SlideOver` (opens, Escape, backdrop, focus in and back, scroll lock restored, not rendered as an overlay from `md`); `Shell` (menu button toggles `aria-expanded`, navigation closes the panel, desktop sidebar present); `ChatPage` composer (textarea has `enterkeyhint="send"`, the send button's accessible name is `Send`, Enter still sends, the placeholder follows the media query). `useVisualViewportHeight` with a fake `visualViewport`. happy-dom doesn't evaluate media queries in CSS, so the breakpoint behaviour inside templates is checked by classes present, not by layout.
- `portal-ui`: `Tabs` and `PageLayout` keep their current tests, plus a check for the wrap/scroll classes.
- core: `app.test.ts` asserts `/sw.js` is `text/javascript` with `no-cache` and `/manifest.webmanifest` is `application/manifest+json`, both without a session.

## Risks / Trade-offs

- [The desktop changes without anyone noticing, since no test renders layout] → Every visible change uses `max-md:`/`md:` or `(pointer: coarse)`. Task 7 compares the main pages at 1280 px before and after in a real browser.
- [iOS keyboard handling differs by version and is hard to test off-device] → Fallbacks keep today's behaviour; the chat keyboard behaviour is a device test on the user's iPhone (task 7), and anything off goes back to decision 4.
- [A touch laptop reports `pointer: coarse`] → Primary pointer on such laptops is the trackpad (`fine`), so the rule doesn't apply; if one does, the only effect is 16 px text in fields.
- [A worker, once installed, outlives a rollback to an image without `sw.js`] → An update check that gets a 404 keeps the old worker, which only turns failed navigations into the offline page: harmless. To remove it for good, ship a `sw.js` that calls `self.registration.unregister()`.
- [The installed iOS app has its own cookie jar] → The user logs in once inside the app. Nothing to change in core; mentioned in the README.
- [`field-sizing` unsupported on an older browser] → The textarea stays one line and scrolls.

## Migration Plan

Nothing to migrate: no database, no configuration, no API change. The deploy is not risky in the CLAUDE.md sense; rolling back the image undoes everything except an installed service worker, which is harmless (see Risks). The service worker needs a secure context; the deployed portal is HTTPS and `pnpm dev` doesn't register it.
