# Design

> From an explore session on 2026-10-27. The goal is to lock Friday down now and build towards multiple users later. For now the only user is the owner.

## Context

See proposal.md for the motivation.

- `friday.thewhite.nl` is LAN-only: AdGuard resolves it to Traefik on 192.168.1.81, and the Cloudflare tunnel only serves `/intake` on the DMZ Pi. One IngressRoute sends the whole host to the `friday` Service.
- Authentik already runs at `auth.thewhite.nl`. The cluster has a ForwardAuth middleware `authentik/authentik` that nothing uses yet. Providers and applications are set up by hand in the Authentik UI (homelab `docs/authentik-integration.md`).
- Non-browser clients already authenticate with their own keys: voice devices with `Authorization: Bearer <key>` on `/ws/audio?device=` and `/ws/device`, and remote modules with a key in the `hello` on `/ws/modules`. `ws.ts` authenticates every connection whose `device` query parameter is present, even when it is empty.
- Core already runs OAuth authorization-code flows for oauth-connections (`packages/core/src/oauth/`, the `arctic` dependency, redirect URIs from `FRIDAY_PUBLIC_URL`). Refresh tokens are stored encrypted with `FRIDAY_MASTER_KEY`.
- The cross-origin rule in `http-server` refuses cross-site writes to `/api/`. Reads are open to anyone on the LAN.
- Nothing has an owner: conversations, agents and their runs, brain pages and revisions (author `user`, `extraction`, `consolidation`, `system`), OAuth connections and calendar configuration.

## Goals / Non-Goals

**Goals:**
- Every browser request has a known user, and a forgotten route is protected by default.
- A user model that the per-user changes can build on without migrating it again.
- Authentik decides who may use Friday, and Friday can also lock a user out straight away.
- Local development stays a plain `pnpm dev`.

**Non-Goals:**
- Filtering data per user. Everyone still sees everything (changes 2 to 4 below).
- Knowing who is speaking to a voice device (change 5).
- API tokens for scripts, local passwords, other identity providers.
- Traefik forward-auth, as an extra layer or otherwise.

## Decisions

### Friday is the OIDC client; no Traefik forward-auth

```
 browser --> friday.thewhite.nl/...
               |
               +-- /api/* without a session --> 401   (portal: go to /auth/login?return_to=<path>)
               |
               |   /auth/login --> auth.thewhite.nl/application/o/authorize/  (code + PKCE + state + nonce)
               |                         | SSO / MFA in Authentik
               |   /auth/callback <------+ code
               |       token exchange (TLS, client secret), check iss/aud/exp/nonce
               |       claims: sub, email, name, preferred_username, groups
               |       JIT provision (below), create session, Set-Cookie, redirect to return_to
               v
 /api/*, browser /ws/audio upgrade: cookie --> session --> user, or 401

 /ws/audio?device=, /ws/device: device key (unchanged)
 /ws/modules: module key (unchanged)
 /health: open
```

Alternatives considered:
- **Traefik forward-auth only.** It's only config, but Friday wouldn't know who is calling, and multi-user is the reason for this change. Once a session expires, an SPA `fetch` follows a cross-origin redirect to Authentik and fails as a CORS error instead of a 401. The voice-device and remote-module paths also need their own route in front of the middleware. That route split has to stay correct forever.
- **Forward-auth plus trusting `X-authentik-*` headers in Friday.** On a route without the middleware, Traefik passes on whatever headers the client sent, and any pod in the cluster can reach the Service directly. Identity would rest on config, not on code.
- **Both Friday's login and forward-auth.** This brings back the expiry and CORS problem and the route split for very little gain.

The flow uses `arctic`, as oauth-connections does, but its generic `OAuth2Client` with the endpoints from OIDC discovery (`<issuer>/.well-known/openid-configuration`), not its Authentik provider. That provider hard-codes Authentik's global endpoints and doesn't expose the end-session endpoint the logout page links to. Discovery also lets the tests run against a fake provider. The ID token comes straight from the token endpoint over TLS, so Friday checks its claims (`iss`, `aud`, `exp`, `nonce`) without verifying the signature against JWKS, as OIDC Core 3.1.3.7 allows. The `groups` claim comes from Authentik's default `profile` scope mapping.

### Sessions

- Server-side sessions in `friday.db`. The cookie holds a random 256-bit token, and the database stores only its SHA-256.
- The cookie is `__Host-friday_session`: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`. Over plain-HTTP localhost the cookie is named `friday_session`, without `Secure` (dev only; see below).
- `SameSite=Lax` plus the existing cross-origin write check is the CSRF defence. No separate CSRF token.
- The browser `/ws/audio` upgrade also checks `Origin` against `Host`. `SameSite=Lax` still sends the cookie from another `*.thewhite.nl` host, because that counts as same-site. Without the check, a compromised app on the same domain could open a voice session as the user.
- **Lifetime:** a session ends after 30 days without use. Every 24 hours, on the next request, Friday refreshes its claims with the refresh token (scope `offline_access`). This updates the name, email and role. When Authentik refuses the refresh (user deactivated, removed from the groups, or token revoked), the session ends and the next request gets 401. The refresh token is stored encrypted with `FRIDAY_MASTER_KEY`, like OAuth connections. Configured auth therefore requires the master key. A session without a usable refresh token (the provider issued none, or it can't be decrypted any more) ends when its claims are due, and the next visit logs in again through Authentik's SSO. Refreshes are single-flight per session: the portal sends several requests at once, and Authentik rotates refresh tokens, so a second use of the same token would be refused.
- Every call to the provider is bounded (10 s). When the provider can't be reached (a timeout, a network error, a 5xx, also from userinfo), the session is kept and its requests don't wait for a refresh again for 5 minutes. A refresh token the token endpoint already rotated before userinfo failed is kept, or the next try would present a used one.
- Sessions idle for 30 days are purged at startup and at every login, also those whose cookie the browser dropped and that would never be presented again, so their sealed refresh tokens don't linger.
- A session that ends (logout, a refused refresh, idle) closes the Talk connections it opened, like disabling the user does.
- Each login attempt has its own login cookie, named by its state, so several tabs sent to the login at once each complete.
- The cookie gets `Max-Age` 30 days at login and isn't renewed. After 30 days of continuous use the browser drops it, and the next request bounces silently through Authentik's SSO.
- Logout (`POST /auth/logout`) deletes the session and clears the cookie. It doesn't end the Authentik SSO session. The portal can then link to Authentik's end-session endpoint.
- `return_to` only accepts a path on the same origin (it starts with `/` and not with `//`), so it can't be used as an open redirect.

Alternative: short sessions (about 12 hours) with a silent bounce back through Authentik's SSO and no refresh tokens. That's simpler, but every first visit of the day shows a redirect flash, and requests in progress hit a 401 at expiry.

### Just-in-time provisioning keyed on `sub`

```
 callback claims
   +-- not in FRIDAY_AUTH_USER_GROUP or FRIDAY_AUTH_ADMIN_GROUP --> 403 page, no user row
   +-- users row for (issuer, sub)?   no  --> INSERT (role from groups, first_login_at)
   |                                  yes --> UPDATE email, name, role, last_login_at
   +-- disabled in Friday?  --> 403 page
   +-- first admin ever?    --> record as the household owner (once)
   +-- session
```

- **The key is `(issuer, sub)`, never the email.** The Authentik provider's subject mode must stay "hashed user ID", the default. Changing it would turn every user into a new person (see Risks).
- **Two gates.** The Authentik application is bound to the two groups, so other people can't complete the login. Friday also checks the `groups` claim, so it doesn't depend on that binding.
- **Role:** `admin` when the user is in the admin group, otherwise `member`. It is set on every login and every claim refresh.
- **JIT creates the user row and nothing else.** Each later change provisions its own data on first use (e.g. a user's brain), so login never needs to know about modules.
- **Disable** is Friday's own flag, set by an admin on the Users page. It ends the user's sessions straight away and refuses their logins. An admin can't disable themselves. Deleting a user waits until there is per-user data to delete with them.

### The household owner instead of reassigning rows now

Existing rows are not reassigned in this change. Core records the first admin who logs in as the **owner** (a core setting, written once, shown on the Users page). Each per-user change then assigns its own existing rows to the owner in its own migration: conversations in change 2, brain tables in change 3, and so on. Change 5 makes the owner the default owner of voice devices. This keeps every migration with the change that needs it. It also keeps core away from modules' tables, which it may not touch (`module-database`).

### Roles and admin-only APIs

The check sits in the router, by path prefix, so a new core route under a listed prefix is protected without extra code:

| Who | Paths |
|---|---|
| open | `/health`, `/auth/*`, static files and the SPA fallback |
| any user | `/api/me`, `/api/chat`, `/api/conversations*`, `/api/agents*`, `/api/tools`, `GET /api/modules`, `/api/modules/<id>/*` (module routes), browser `/ws/audio` |
| admin | `/api/config*`, `/api/mcp/*`, `/api/keys*`, `/api/devices*`, `/api/oauth/*`, `/api/jobs*`, `/api/alerts*`, `/api/users*`, `POST /api/modules/:id/reload` |

Every `/api/*` path that isn't listed requires a session (a user). Members get 403 on admin paths. The portal hides the System section for members, but the server enforces it. Module routes get `req.user` and may check the role themselves. A declarative admin-only flag for module routes can come later.

`/api/oauth/:provider/callback` is admin-only too. The browser that started the flow belongs to an admin with a session (`SameSite=Lax` sends the cookie on the top-level redirect back).

### Local development: a dev user on loopback only

When `FRIDAY_AUTH_ISSUER` is not set:
- A request from a **loopback address** (`127.0.0.1`, `::1`) gets a fixed dev user (`dev`, role `admin`), stored like any other user. This covers the Vite proxy and a browser on the same machine.
- Any other request gets 401. Core binds `0.0.0.0` by default, so another device on the LAN must not inherit the dev admin.
- At startup Friday logs a loud warning. It **refuses to start** when `FRIDAY_PUBLIC_URL` is set to anything other than an `http://localhost` or `http://127.0.0.1` URL, because that means a deployment without auth configured.

The request must also be addressed to the local machine (`Host` is `localhost`, `127.0.0.1` or `[::1]`): a reverse proxy on the same machine forwards its public name, and a DNS-rebinding page its own, so neither gets the dev admin.

In k8s, requests come from Traefik and never from loopback, so even a misconfiguration falls back to 401 for everyone rather than to admin access.

### The user in the SDK, explicitly

```
 RouteRequest.user?         { id, name, role }   module routes (always set behind the session check)
 ToolCallContext.user?      { id, name }         chat and the Talk page; absent for device sessions,
                                                 scheduled agents, MCP and remote tools
 PromptContextInfo.user?    { id, name }         chat and the Talk page; absent for device sessions
 createTestHost({ user })                        sets the user for routes, calls and prompts
```

The user is passed explicitly rather than through an `AsyncLocalStorage` "current user". Jobs have no request to take a user from, and a typed field shows where a user can be missing. A missing ambient user only shows up as data that is silently shared. Nothing filters by user in this change. The fields are here so changes 2 to 5 don't have to touch the SDK contract again.

### Attribution

Nullable `user_id` columns, set from this change on, never backfilled:
- `conversations.user_id`: chat and the Talk page. Device sessions stay `NULL` until change 5.
- `agent_runs.user_id`: who started a run from the portal, chat or the Talk page. `NULL` for a scheduled run.
- `agent_actions.decided_by`: who approved or rejected.
- `brain__revisions.user_id` and `user_name` (brain module migration 4): set for revisions with author `user` made through the portal, from `req.user`. The name is a snapshot, because a module may not read core's `users` table (`module-database`). The store is synchronous, so the routes set the user around each store call (`store.asUser`), never around a whole async handler, where overlapping requests could swap users.

### Portal

- The API client: a 401 sends the browser to `/auth/login?return_to=<current path>`. For SSE (chat) and the Talk WebSocket, a 401 or a refused upgrade does the same once the current turn has ended. It never interrupts a turn in progress.
- `/api/me` loads the user before the shell renders, so a member never sees the System section flash.
- A user menu at the bottom of the sidebar shows the name, role and `Log out`.
- `System > Users` (`/settings/users`, admin) lists name, email, role, owner badge, first and last login, and status, with Disable and Enable.
- The 403 page after login ("you don't have access to Friday") has a link to log out of Authentik, so the user can try another account.

## Later changes (context, not in scope)

```
 2. user-chat          conversations, chat and search scoped per user; ctx.conversations per user;
                       existing conversations go to the owner
 3. user-brain         a separate brain per user: user_id on brain__* tables, names unique per user,
                       each user's own Me, nightly per user, prompt context from that user's brain;
                       existing brain goes to the owner
 4. user-connections   OAuth connections and calendars per user (my Spotify, your Spotify)
 5. voice-identity     a device has an owner (default: the household owner); its sessions use the
                       owner's history and brain
```

**Separate brains, by choice.** Each user gets their own brain, not a shared household brain with private pages. People see the same things differently, and those differences are worth keeping, not merging away. Comparing brains ("you have the boiler service due in March, and Sanne's notes say February") is a possible later change. It needs explicit permission to read across brains.

## Risks / Trade-offs

- [The Authentik provider's subject mode changes and every `sub` with it] → `infra/README.md` says to keep "hashed user ID". A login whose `sub` is new but whose email matches an existing user is refused with a clear log line, and no duplicate is created. An admin resolves it by hand.
- [Authentik is down: nobody can log in] → Existing sessions keep working until their claim refresh fails. A failed refresh caused by a network error (not a refusal) keeps the session and retries on a later request. Devices and remote modules don't depend on Authentik at all.
- [Scripts calling `/api` break (**BREAKING**)] → Accepted for now. Personal API tokens issued by Friday are a possible later change.
- [A member reaches admin functionality through a module route] → Module routes get the role and today expose household features only. A declarative admin flag can come later.
- [The dev user leaks to the LAN] → Loopback-only, and Friday refuses to start without auth when `FRIDAY_PUBLIC_URL` isn't localhost.
- [The `groups` claim is missing because of the scope mapping] → Login fails with "not in a Friday group" and a log line naming the claims received. `infra/README.md` documents the scopes.
- [The brain page's "Run it now" calls the admin-only `/api/jobs/brain/nightly/run`, so a member gets 403] → Accepted until `user-brain`, where the nightly runs per user. The page shows the 403 as an error.
- [A long chat stream when the session expires] → The check happens when the request starts, and the stream finishes. The next request gets the 401.

## Migration Plan

1. In Authentik (by hand, documented in `infra/README.md`): create the groups `friday-users` and `friday-admins` with the owner in `friday-admins`. Create an OAuth2/OpenID provider `friday` (confidential, redirect URI `https://friday.thewhite.nl/auth/callback`, scopes `openid email profile offline_access`, subject mode "hashed user ID"), and an application `friday` bound to both groups.
2. Add `FRIDAY_AUTH_ISSUER`, `FRIDAY_AUTH_CLIENT_ID` and `FRIDAY_AUTH_CLIENT_SECRET` to `friday-secrets`. `FRIDAY_MASTER_KEY` is already there.
3. Merge and deploy. The first login creates the owner. Devices and remote modules keep working unchanged.

Rollback: redeploy the previous image. The new tables and nullable columns are left alone by the old code.

## Open Questions

- Does Authentik's `end_session` endpoint redirect back to Friday after logout, or does the portal just show a "logged out" page?
- The exact wording and layout of the 403 "no access" page.
