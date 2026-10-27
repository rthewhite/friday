# Proposal

## Why

Friday holds more and more personal data: the brain, conversations, calendars, agents that run tools, MCP servers and OAuth connections. Yet anyone on the LAN can read and change all of it without logging in. The cross-origin check only stops other websites, not a guest's phone or a curl. Friday is also meant to serve more than one person later. That needs a known user behind every request. This change is the first step: users who log in, with roles and attribution, while all data stays shared.

## What Changes

- **Login through Authentik (OIDC), done by Friday itself.** Friday is an OIDC client of the homelab's Authentik (`auth.thewhite.nl`). There is no Traefik forward-auth. `/auth/login`, `/auth/callback` and `/auth/logout` use the authorization-code flow. The session is server-side in `friday.db` with a `__Host-` cookie.
- **Everything for browsers requires a session.** Every `/api/*` request answers 401 without a session. The portal and its static files are served, but the portal goes to login on a 401. The browser connection to `/ws/audio` is refused without a session. Voice devices (`/ws/audio?device=`, `/ws/device`) and remote modules (`/ws/modules`) keep their own keys and are unchanged. `/health` stays open.
- **Just-in-time provisioning.** The first successful login creates the user, keyed on the OIDC `sub`. Every later login updates the name, email and role from the claims. Only members of the Authentik groups for Friday get in (default `friday-users` and `friday-admins`). Other people are refused, and no user is created for them.
- **Roles: admin and member.** The role follows the Authentik groups on every login. Settings and the APIs behind it are admin-only: configuration and secrets, MCP servers, voice devices, remote module keys, OAuth connections, jobs, alerts, users and module reload. An admin can disable a user in Friday, which ends their sessions straight away.
- **Attribution, no filtering.** New conversations, agent runs, agent approvals and brain edits made from the portal record the user who made them. Everyone still sees the same shared data. The first admin who logs in is recorded once as the household **owner**. Later per-user changes assign existing data to the owner.
- **The user reaches modules.** Module routes, tool calls and prompt context receive the current user when there is one. This is plumbing for the later per-user changes; no module uses it to filter yet.
- **Portal:** login and session expiry handling, a user menu with logout, and a `Users` page under System (name, email, role, first and last login, disable). Members don't see the System section.
- **Local dev:** when auth is not configured and Friday runs on localhost, every request gets a fixed dev admin. Outside localhost Friday refuses to start without auth configured.

Later changes, recorded in `design.md`: per-user chat and conversations, a separate brain per user, per-user OAuth connections and calendars, and voice identity (a device's sessions belong to its owner).

## Capabilities

### New Capabilities

- `user-auth`: OIDC login against Authentik, sessions, just-in-time provisioning, roles from groups, disabling users, admin-only APIs, the dev user, the startup check, the household owner, and the Users page.

### Modified Capabilities

- `http-server`: `/api/*` requires a session, `/auth/*` routes are served, and API paths that answer 401 are listed alongside the existing cross-origin rule.
- `audio-transport`: a browser connection to `/ws/audio` without `device` requires a session. Device connections are unchanged.
- `portal-shell`: going to login on a 401, the user menu with logout, the `Users` entry under System, and the System section shown only to admins.
- `module-system`: `RouteRequest` and the prompt context info carry the current user. The test host can set one.
- `tool-registry`: the call context carries the current user.
- `conversation-store`: a conversation records the user it belongs to when known (chat and the Talk page). Device sessions have no user yet.
- `agents`: a run records the user who started it, and an approval or rejection records who decided.
- `brain`: a revision made through the portal records the user who made it.

## Impact

- Core: new `packages/core/src/auth/` (OIDC flow via the existing `arctic` dependency, sessions, users, middleware), `router.ts`/`app.ts` (session check, admin-only routes), `transports/ws.ts` (session on browser upgrade), the chat and agents paths (attribution), and a migration in `storage/db.ts` (`users`, `sessions`, nullable `user_id` columns).
- SDK: `user` on `RouteRequest`, `ToolCallContext` and `PromptContextInfo`, and a test host option.
- Modules: the brain records the user on revisions made through the portal (module migration).
- Portal: the 401 handling in the API client and SSE/WebSocket, the user menu, `UsersPage.vue`, and the admin-only System section. Vite proxies `/auth` in dev.
- Configuration: `FRIDAY_AUTH_ISSUER`, `FRIDAY_AUTH_CLIENT_ID`, `FRIDAY_AUTH_CLIENT_SECRET` (secret), and optionally `FRIDAY_AUTH_USER_GROUP` and `FRIDAY_AUTH_ADMIN_GROUP`. `FRIDAY_PUBLIC_URL` builds the redirect URI. Updates to `.env.example`, `deploy/k8s.yaml`, the README, `infra/README.md` (the Authentik provider and application set-up, done by hand) and the `openspec/config.yaml` context.
- Homelab: a new OAuth2/OIDC provider and application `friday` in Authentik, plus the two groups. No Traefik change.
- **BREAKING** for scripts calling `/api` without a browser session: they get 401. Personal API tokens are a possible later change.
- Overlap: `sonos-speakers` and `oauth-keepalive` are in flight. Check their Impact sections against `app.ts`, `router.ts` and the portal shell before applying.
