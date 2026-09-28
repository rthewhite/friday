# @friday/portal-ui

Design tokens and base components for the Friday portal and module pages. Import components from `@friday/portal-ui`; the portal imports `@friday/portal-ui/tokens.css` once.

## Page anatomy

Every page uses `PageLayout` with an `eyebrow` (section name: Assistant, Modules, System), a `title`, a `subtitle`, and header actions in the `actions` slot (Refresh, New …). Content is one or more `DataTable`s or `Card`s. Editing happens in a `Drawer`, never inline in a table row.

```vue
<PageLayout eyebrow="System" title="Configuration" subtitle="…">
  <template #actions><Button variant="ghost"><Icon name="refresh" />Refresh</Button></template>
  <Tabs v-model="tab" :items="[{ id: 'a', label: 'A', count: 3 }]" />
  <DataTable :columns="columns" :rows="rows" row-key="id" clickable @row-click="open">
    <template #cell-status="{ row }"><StatusDot tone="success" :label="row.status" /></template>
  </DataTable>
  <Drawer v-model:open="drawerOpen" title="Edit">…<template #footer><Button>Save</Button></template></Drawer>
</PageLayout>
```

## Components

| Component | Purpose |
|---|---|
| `PageLayout` | eyebrow, title, subtitle, `actions` slot |
| `Card` | surface with optional title and `header` slot |
| `Button` | `variant`: primary, ghost, danger |
| `Input` | labelled text/password input with `v-model` |
| `DataTable` | typed columns (`width`, `align`, `hideBelow: md|lg`), `clickable` rows emitting `row-click`, `cell-<key>` and `actions` slots |
| `Tabs` | pill tab group with optional counts, `v-model` |
| `StatusDot` | coloured dot with label, `tone` |
| `Chip` | small mono pill for ids |
| `Badge` | rounded label, `tone` |
| `Drawer` | right-hand panel, `v-model:open`, `title`, `subtitle`, `footer` slot, Escape and overlay close |
| `Icon` | inline SVG by name (mic, chat, keyboard, grid, play, settings, key, refresh, plus, close, chevron, server, link); unknown names render as text so emoji still work |

## Dates and times

Always format timestamps with `formatDateTime`, `formatDate` or `formatTime` from `@friday/portal-ui`. They use Dutch notation, `26-09-2026, 22:10:07`, with a 24-hour clock, and accept ISO strings, numbers or `Date` plus an optional fallback for empty values. Never call `toLocaleString` directly in a page.

## Module UI contract

`defineModuleUi({ id, nav: { label, icon, order }, routes })`. `icon` is an `Icon` name or short text. Routes are Vue Router records relative to `/m/<id>`.
