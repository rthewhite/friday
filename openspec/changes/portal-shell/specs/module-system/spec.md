# Spec Delta

## ADDED Requirements

### Requirement: Module-scoped HTTP routes

`ctx.http.route(method, path, handler)` SHALL register a handler served at `/api/modules/<id>/<path>`, where `path` may contain `:param` segments. Handlers SHALL receive `(req, res, params)` with a JSON body helper. Routes SHALL be removed when the module is disposed or fails to load. Remote modules SHALL NOT have routes.

#### Scenario: Register a route
- **WHEN** media calls `ctx.http.route("GET", "search", handler)`
- **THEN** `GET /api/modules/media/search?q=x` invokes the handler

#### Scenario: Route with param
- **WHEN** media registers `GET items/:id`
- **THEN** `/api/modules/media/items/42` invokes it with `params.id === "42"`

#### Scenario: Module fails
- **WHEN** a module registered routes and then throws in `init`
- **THEN** its routes respond 404

### Requirement: Manifest declares UI presence

A manifest MAY set `ui: true` to indicate the module ships a portal UI; `/api/modules` SHALL expose it as `ui`.

#### Scenario: Listing
- **WHEN** media sets `ui: true`
- **THEN** `/api/modules` shows `"ui": true` for media
