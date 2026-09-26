# Design

## Context

The portal has `PageLayout`, `Card`, `Button`, `Input`, `Table` (basic), `Badge`. Pages compose cards; Configuration renders a form per key. The sidebar renders a flat list with an optional group label. `/api/config` returns one entry per (module, key). The Jarvis config screen (reference screenshot, 2026-09-26) is the target look: eyebrow + title + header actions, pill tabs with counts, a single dense table, chips for requesters, editing off-row.

## Goals / Non-Goals

**Goals:**
- Dense, scannable tables; editing in a drawer; one row per key.
- Consistent page anatomy: eyebrow, title, subtitle, actions top right.
- Sidebar with sections and real icons.

**Non-Goals:**
- Light theme, responsive rework beyond keeping the 360 px collapse working.
- Live status updates over WebSocket (Jarvis's "updates live"); a Refresh action is enough.
- Changing what is stored or how values resolve.

## Decisions

### D1. Components in portal-ui, pages only compose

`DataTable<T>` replaces `Table`: `columns: { key, label, width?, align? }`, `rows`, `rowKey`, `clickable`, emits `row-click`, cell slots as today, sticky header row with the `f-surface-elevated` background, row hover. `Tabs`: `items: { id, label, count? }`, `modelValue`. `StatusDot`: `tone` plus label. `Drawer`: right-side panel (`w-full sm:w-[28rem]`), overlay, `title`, `open` model, footer slot, closes on Escape and overlay click. `Chip`: mono small pill for ids. `PageLayout` gains `eyebrow` prop rendered uppercase accent above the title. Icons: a tiny `Icon` component with an inline SVG map (mic, grid, play, settings, key, refresh, plus, chevron) so module UIs can use `nav.icon` names as well as emoji strings (fallback to text).

### D2. Per-key configuration entries

`configListing` groups by key: `{ key, secret, required, description, modules: [{ id, required }], status, scope, value?, updatedAt? }`. `required` is true when any requester requires it. `description` is taken from the first module that provides one. Status resolution uses each requesting module's scope in turn: `set` if stored in any requester's scope or global, else `env`, else `pending`; the drawer lists per-module status when scopes differ. `ConfigStore.keys()` includes `updated_at`. Undeclared globals have `modules: []`.

### D3. Drawer-based editing

Row click sets `selected` and opens the drawer with: key and description, requested-by chips, value field (plain: text prefilled; secret: masked, empty), scope select (each requesting module or global), and footer buttons Save, Save and reload (disabled when scope is global or no module), Clear (when set). Header action "Add value" or "Add secret" opens the same drawer with an editable key field. Deep link `?tab=` stays; `?key=` opens the drawer for that key.

### D4. Sidebar sections

`NavItem.group` becomes required and sections render in order Assistant, Modules, System. Module UI entries go under Modules after the Modules page. Brand row: 28 px round mark with "F" in accent plus the name.

## Risks / Trade-offs

- [Denser table on narrow screens] → `DataTable` scrolls horizontally inside `surface-card`; hide `description` and `updated` columns under `md`.
- [API shape change] → Only the portal consumes `/api/config`; the tests and page change together.
- [Emoji to SVG icons] → Module UIs that pass emoji keep working through the text fallback.

## Open Questions

None.
