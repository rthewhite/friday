# Tasks

## 1. Users, sessions and attribution columns in friday.db

- [x] 1.1 Add core migration 11 (renumber at merge if `main` has claimed it): `users` (id, issuer, subject, email, name, role, disabled, first/last login; unique issuer+subject), `sessions` (token hash, user, encrypted refresh token, created/last used/last refreshed), an `auth_owner` setting, and nullable `conversations.user_id`, `agent_runs.user_id`, `agent_actions.decided_by`. Verify with a migration test that a database at version 10 upgrades and the old rows keep `NULL`.
- [x] 1.2 Implement the user store: upsert by (issuer, subject) with the name fallback (`name`, `preferred_username`, email), refusing a new subject whose email belongs to another user, the dev user, disable/enable, and owner recorded once by the first admin (never the dev user). Verify with `packages/core/test/user-store.test.ts` covering each `user-auth` provisioning, owner and disable scenario.
- [x] 1.3 Implement the session store: 256-bit random tokens with only the SHA-256 stored, the refresh token encrypted with the master key, end after 30 days unused, end all sessions of a user, and a "due for refresh" check at 24 hours. Verify with `packages/core/test/session-store.test.ts` (token not stored, idle session, ending a user's sessions, due for refresh).

## 2. Configuration, startup checks and the dev user

- [x] 2.1 Read `FRIDAY_AUTH_ISSUER`, `FRIDAY_AUTH_CLIENT_ID`, `FRIDAY_AUTH_CLIENT_SECRET`, `FRIDAY_AUTH_USER_GROUP` and `FRIDAY_AUTH_ADMIN_GROUP` from the environment only, not as stored configuration keys. Changing them in the portal could lock everyone out, and Settings itself sits behind the login. Add the startup checks: missing client id, secret, master key or `FRIDAY_PUBLIC_URL` with auth configured, and a non-localhost `FRIDAY_PUBLIC_URL` without auth. Verify with `auth-config.test.ts` cases for each "Authentication is configured" and "Deployed without authentication" scenario.
- [x] 2.2 Resolve the request's user without auth configured: the dev user for a loopback peer address (IPv4, `127.0.0.0/8`, `::1`, IPv4-mapped), and no user otherwise, ignoring forwarded headers, plus the startup warning. Verify with unit tests for the address rules and the forged `X-Forwarded-For` scenario.
- [x] 2.3 Document the keys in `.env.example`, with a comment that leaving `FRIDAY_AUTH_ISSUER` empty means only the local machine gets in. Verify that `pnpm dev` with the example `.env` starts and logs the warning.

## 3. Login, callback and logout

- [x] 3.1 Add a test helper that runs a fake OIDC provider on loopback: discovery, authorize redirect, token endpoint with ID tokens and refresh tokens, configurable claims and refusal, and an end-session endpoint. Verify it with a smoke test that runs one code exchange.
- [x] 3.2 Implement `GET /auth/login` with the `arctic` Authentik provider (PKCE S256, state, nonce, scopes `openid email profile offline_access`) and the 10-minute login cookie, with `return_to` limited to Friday's own paths. Verify with tests for the redirect parameters and the open-redirect scenarios (`//evil.example/`, `/\evil`).
- [x] 3.3 Implement `GET /auth/callback`: state check, code exchange, `iss`/`aud`/`exp`/`nonce` checks, group gate, provisioning, owner, start a session with the right cookie name and attributes (`__Host-` on https, plain on http), and redirect. Provider errors and failures go to an error page and the no-access 403 page, and the login cookie is cleared. Verify with `auth-flow.test.ts` against the fake provider for every login, group and provisioning scenario in `user-auth`.
- [x] 3.4 Implement `POST /auth/logout` (ends the session, clears the cookie, answers 200 with `{ endSessionUrl }`, the provider's end-session URL when advertised, applies the cross-origin rule) and 404 for `/auth/*` without auth configured. Verify with the logout and cross-site logout scenarios.

## 4. Session check, roles and the users API

- [ ] 4.1 Resolve the session for every request: cookie to session to user, ending sessions that are idle, disabled or refused at refresh. When the session is 24 hours past its last refresh, refresh the claims with the refresh token (update the user and role, apply the group gate). When the provider is unreachable, keep the session. Verify with tests against the fake provider: promoted, demoted, removed in the provider, provider down.
- [ ] 4.2 Enforce access in the router before dispatch: cross-origin check, then session (401 `unauthenticated`), then the admin-only prefixes (403 `forbidden`). An unknown `/api` path answers 401 without a session and 404 with one. `/health`, `/auth/*` and static files stay open. Verify with an `auth-access.test.ts` table test over every prefix in the spec for no session, member and admin. Run the existing core API tests unchanged; they pass as the loopback dev user.
- [ ] 4.3 Add `GET /api/me`, `GET /api/users`, `POST /api/users/:id/disable` and `/enable`: 409 on disabling yourself or the dev user, disable ends sessions, and no tokens or subjects in responses. Verify with `users-api.test.ts`.
- [ ] 4.4 Run `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck`. Verify both are green.

## 5. The browser voice connection

- [ ] 5.1 Authenticate the browser `/ws/audio` upgrade: a session is required (401 otherwise, before any Gemini session), `Origin` must match `Host` (403), and a present `device` parameter, even an empty one, always goes to device auth. Verify with `ws.test.ts` cases: logged in, no session, empty device parameter, cross-site page.
- [ ] 5.2 Track the user of each browser connection, and close them with `4401` when the user is disabled. Verify with the "user disabled mid-session" scenario.

## 6. The user in the SDK and core's call paths

- [ ] 6.1 Add `user` to `RouteRequest` (`{ id, name, role }`), `ToolCallContext` and `PromptContextInfo` (`{ id, name }`), and the `user` option to `createTestHost` (route requests default to an admin test user, calls and prompts to none, overridable per call). Verify with `packages/sdk` tests for the test-host scenarios.
- [ ] 6.2 Pass the user in core: module routes get `req.user`, and chat turns, browser voice sessions and user-started agent runs pass `user` to `callTool` and to prompt context. Device sessions and scheduled runs pass none, and MCP and remote tools never see it. Verify with core tests for "handler sees its user", "device session has no user", and the prompt context chat and voice-device scenarios.
- [ ] 6.3 Run `pnpm --filter @friday/sdk test typecheck` and `pnpm --filter @friday/core test typecheck`. Verify both are green, and that every module still typechecks (`pnpm -r typecheck`).

## 7. Attribution

- [ ] 7.1 Record the user on conversations (chat threads keep their starter, browser voice sessions their user, agent runs their starter) and include `user` in `GET /api/conversations` and `/:id`. Verify with `conversations-store.test.ts` and `chat-api.test.ts` cases for chat, voice device and "not filtered".
- [ ] 7.2 Record the starting user on agent runs and `decidedBy` on approved or rejected actions, and include them in the agents API. Verify with `agents-api.test.ts` and `agent-approvals.test.ts` cases for portal start, scheduled run and approval.
- [ ] 7.3 Add brain module migration 4: nullable user id and name on `brain__revisions`. Record `req.user` on revisions with author `user` written through the brain's routes, return it in the history API, and show the name in the portal history. Verify with brain tests for the "edit in the portal" and "remembered by a tool" scenarios, and `pnpm --filter @friday/module-brain test typecheck`.

## 8. Portal

- [ ] 8.1 Load `/api/me` before mounting the shell. On 401, navigate to `/auth/login?return_to=<path+query>`. Proxy `/auth` in `vite.config.ts`. Verify by unit-testing the boot helper, and manually with `pnpm dev`: the portal loads as `Dev`.
- [ ] 8.2 Handle 401 globally: the API fetch helper, module UIs through `@friday/portal-ui` or a shared fetch wrapper, SSE in `lib/sse.ts` (after the streaming reply finishes), and the Talk page's refused upgrade when no session is connected. Show 403 as a page error. Verify with unit tests for the fetch and SSE helpers.
- [ ] 8.3 Make the shell role-aware: the System section only for admins, the admin-only page for members on `/settings/*` (no API calls), and the user menu with name, role and `Log out`, plus the logged-out page with the Authentik link when one is given. The dev user has no `Log out`. Verify with component tests for member and admin navigation and the dev user menu.
- [ ] 8.4 Add `System > Users` (`/settings/users`): table, drawer with Disable (confirmation) and Enable, no Disable on your own row or the dev user's row, and help text. Verify with a component test, and manually that disabling a second user works in `pnpm dev` (seeded user).
- [ ] 8.5 Run `pnpm --filter @friday/portal test typecheck build`. Verify all three are green.

## 9. Deployment and documentation

- [ ] 9.1 `deploy/k8s.yaml`: comment that `friday-secrets` must hold `FRIDAY_AUTH_ISSUER`, `FRIDAY_AUTH_CLIENT_ID` and `FRIDAY_AUTH_CLIENT_SECRET`, and that `FRIDAY_PUBLIC_URL` builds the login redirect URI. Verify that `kubectl apply --dry-run=client -f deploy/k8s.yaml` (with `IMAGE_TAG` substituted) succeeds.
- [ ] 9.2 `infra/README.md`: the Authentik set-up from design.md's Migration Plan (groups, OAuth2/OpenID provider with redirect URI, scopes, subject mode "hashed user ID" and why it must not change, application bound to the groups), adding the keys to `friday-secrets`, and that the first admin to log in becomes the owner. Update the endpoint table: the browser needs a login, devices and remote modules are unchanged. Verify by reading it against the design.
- [ ] 9.3 README: a section on logging in, roles, the dev user, and that scripts calling `/api` now get 401. `openspec/config.yaml` context: auth in core (`packages/core/src/auth/`), users and sessions, the user on `RouteRequest`, `ToolCallContext` and `PromptContextInfo`, attribution, owner. Verify that `openspec validate --strict auth-users` still passes.

## 10. Integration

- [ ] 10.1 End-to-end test against the fake provider: log in as an admin (becomes owner), then a member. The member chats (conversation records the member, tool call context carries the user), gets 403 on `/api/config`, and is disabled by the admin. The member's next request gets 401 and their Talk connection closes. Verify the test passes in `pnpm --filter @friday/core test`.
- [ ] 10.2 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`. Verify all green.
- [ ] 10.3 (user, after deploy) Set up the provider and application in Authentik, add the keys to `friday-secrets`, deploy, and log in at `https://friday.thewhite.nl`. Verify that the owner is recorded, a second account outside the groups gets the no-access page, the Voice PE and the reSpeaker still connect, and a remote module still connects.
