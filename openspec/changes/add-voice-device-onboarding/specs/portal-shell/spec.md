# Spec Delta

## MODIFIED Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row and three sections labelled `Assistant`, `Modules` and `System`. `Assistant` SHALL contain `Talk`, `Chat` and `Conversations`; `Modules` SHALL contain the `Modules` page followed by one entry per enabled module UI ordered by `nav.order` then label; `System` SHALL contain `Configuration`, `Voice devices`, `Remote modules` and `Jobs`. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted, and `Chat` SHALL be highlighted on `/chat` and on every `/chat/<id>`. The shell SHALL work at widths down to 360 px by collapsing the sidebar into a menu.

#### Scenario: Default navigation
- **WHEN** the portal loads with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk`, `Chat` and `Conversations` under Assistant, `Modules` and `Media` under Modules, and `Configuration`, `Voice devices`, `Remote modules` and `Jobs` under System

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not enabled" page

#### Scenario: Chat thread highlighted
- **WHEN** the user is on `/chat/<id>`
- **THEN** the `Chat` item is highlighted

### Requirement: Settings section

The sidebar's `System` section SHALL contain `Configuration`, `Voice devices`, `Remote modules` and `Jobs`, routing to `/settings/config`, `/settings/devices`, `/settings/keys` and `/settings/jobs`.

#### Scenario: Navigation
- **WHEN** the portal loads
- **THEN** `System` shows all four pages and they route to `/settings/config`, `/settings/devices`, `/settings/keys` and `/settings/jobs`
