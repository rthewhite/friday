# Spec Delta

## MODIFIED Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row and three sections labelled `Assistant`, `Modules` and `System`. `Assistant` SHALL contain `Talk` and `Conversations`; `Modules` SHALL contain the `Modules` page followed by one entry per enabled module UI ordered by `nav.order` then label; `System` SHALL contain `Configuration`, `Remote modules` and `Jobs`. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted. The shell SHALL work at widths down to 360 px by collapsing the sidebar into a menu.

#### Scenario: Default navigation
- **WHEN** the portal loads with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk` and `Conversations` under Assistant, `Modules` and `Media` under Modules, and `Configuration`, `Remote modules` and `Jobs` under System

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not enabled" page
