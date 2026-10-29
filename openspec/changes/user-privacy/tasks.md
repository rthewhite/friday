# Tasks

## 1. SDK: users, scoped conversations, owner-only tools

- [x] 1.1 Add `ctx.users` (`owner()`, `list()`, `onOwner(handler)`) to `ModuleContext`, failing with "users are not available in that host" in the remote runner. Verify with SDK tests for the remote-host error and the types.
- [x] 1.2 Replace the unscoped `ctx.conversations.list/get/search` with `forUser(id)` (the same three, limited to that user), and add `userId` to `QuietEvent`. `MemoryConversations` seeds take a user. Verify with SDK tests: one user's view never returns another user's seeded conversation, and `onQuiet` carries the user.
- [x] 1.3 Add `ownerOnly?: true` to `Tool`. The registry takes an owner check: `declarations(channel, user?)` leaves owner-only tools out for non-owners, and `callTool` refuses them for non-owners and calls without a user, with the owner-only error and no handler call. Verify with `registry.test.ts` cases for declarations, a forced call and a call without a user.
- [x] 1.4 Test host: the `users` and `owner` options, a way to record the owner later that fires `onOwner`, user-scoped conversations, and calls without a user counting as the owner's. Verify with `test-host` tests for each `module-system` "Test host fakes users and the owner" scenario, and run `pnpm --filter @friday/sdk test typecheck build`.

## 2. Core: ownership and the owner fallback

- [ ] 2.1 Resolve the owner in core: the recorded owner, the dev user without auth configured, else none. `UserStore` notifies when the owner is first recorded. Verify with `user-store.test.ts` cases (event fires once; dev mode resolves the dev user).
- [ ] 2.2 Add core migration 13 (renumber at merge if taken): `agents.created_by`. Assign unowned `conversations`, `agents` and `agent_runs` rows to the owner at startup and right after the owner is first recorded, idempotently. Verify with a migration test and an assignment test (only NULL rows change; repeating changes nothing; a fresh install assigns after the first admin login).
- [ ] 2.3 Implement `ctx.users` in the module host from the user store (active users only, no emails or subjects). Remove `onOwner` subscriptions on dispose and reload. Verify with `module-host.test.ts` cases.
- [ ] 2.4 Hold voice device sessions for the owner: prompt context, tool calls and the recorder's `userId` (no user while no owner is recorded). Verify with `ws.test.ts` and `session.test.ts` cases for the "Voice devices act for the owner" scenarios. Run `pnpm --filter @friday/core test typecheck`.

## 3. Core: private conversations and chat

- [ ] 3.1 Scope the conversation store's read paths (list, get, search, delete) to a user, and serve `forUser` and the user-carrying `onQuiet` to modules. Verify with `conversations-store.test.ts` cases: another user's conversation is absent from list and search, and a 404 for get and delete; retention still deletes everyone's.
- [ ] 3.2 The conversations routes and the chat engine pass `req.user`: another user's id answers 404 on read and delete, and continuing another user's thread answers 404 with nothing recorded. Verify with `conversation-users.test.ts` and `chat-api.test.ts` cases for the `conversation-store` and `portal-chat` scenarios.
- [ ] 3.3 Run `pnpm --filter @friday/core test typecheck`. Verify both are green.

## 4. Core: owner-only tools in sessions, chat and agents

- [ ] 4.1 Give the registry its owner check in `server.ts`. Snapshot voice declarations for the session's user at open, build chat declarations per turn for its user, and resolve agent tools for the creator. Verify with tests: a member's chat turn and Talk session don't offer an owner-only tool, and the owner's do.
- [ ] 4.2 Run `pnpm --filter @friday/core test typecheck`. Verify both are green.

## 5. Core: agents belong to their creator

- [ ] 5.1 Set `created_by` on create. Scope the agents API (list, get, edit, delete, run, runs, cancel, approve, reject) to the creator, with 404 for everyone else. A taken name answers 409 without revealing the other agent. Verify with `agents-api.test.ts` cases for the "Agents belong to their creator" scenarios.
- [ ] 5.2 Every run acts as the creator: scheduled, portal, `run_agent`, and approved actions (tool calls and the conversation). Verify with `agent-users.test.ts` cases, including a scheduled run calling a tool.
- [ ] 5.3 Agent jobs record only the outcome as their summary. `POST /api/jobs/core/agent-<name>/run` is refused (403) for anyone but the creator. Verify with `agent-triggers.test.ts` and `jobs` API tests.
- [ ] 5.4 `run_agent`'s description no longer lists agents, and it refuses another user's agent. Core prompt context lists the prompt user's enabled, startable agents. Verify with tests for the "Another user's agent" scenario and the prompt context.
- [ ] 5.5 Run `pnpm --filter @friday/core test typecheck`. Verify both are green.

## 6. Brain: a store per user

- [ ] 6.1 Brain migration 5:
  - `user_id` on `brain__pages`, `brain__runs`, `brain__names` and `brain__tombstones`;
  - names and tombstones rebuilt with primary key `(user_id, key)`;
  - the one-profile index replaced by one profile per user.

  Verify with a migration test on a copy of a populated brain fixture (pages, aliases, tombstones, runs and revisions survive unchanged, `user_id` NULL).
- [ ] 6.2 Assign the brain's unowned rows to the owner at init and on `onOwner`, including the storage keys (watermarks, guidance markers) moving under the owner's prefix. Verify with tests for the upgrade and fresh-install scenarios.
- [ ] 6.3 Make `BrainStore` per user (`forUser(id)`). Every query carries the user; the profile is "this user's `is_profile` row"; a brain is created on first use with a subject named after the user. Verify by running the existing store tests through a user's store, plus a "same name, two brains" test.
- [ ] 6.4 Run `pnpm --filter @friday/module-brain test typecheck`. Verify both are green.

## 7. Brain: tools, prompt and routes per user

- [ ] 7.1 The tools act for `call.user` (else the owner). `brain_recall_conversations` searches `ctx.conversations.forUser(<user>)`. Verify with `tools.test.ts` cases, including "another user's conversations are never found".
- [ ] 7.2 Prompt context renders the prompt user's brain. Verify with `context.test.ts`: a new user's prompt holds their empty brain, not the owner's.
- [ ] 7.3 Routes act for `req.user`: `pages/profile` is the caller's profile, and another user's page answers 404. The Brain page works unchanged for each user. Verify with `routes.test.ts` cases for two users.
- [ ] 7.4 Run `pnpm --filter @friday/module-brain test typecheck`. Verify both are green.

## 8. Brain: the nightly pass per user

- [ ] 8.1 `brain/nightly` loops over `ctx.users.list()`:
  - extraction, consolidation and summary per user, with per-user watermarks and guidance markers;
  - each user's run recorded in their brain;
  - one user's failure makes the job `partial` without stopping the others;
  - the job summary holds counts only.

  Verify with `nightly.test.ts` cases for the "two users" and "one user fails" scenarios.
- [ ] 8.2 Runs, review and revert are per user (404 for another user's run). Add `POST runs/now`, which runs the pass for the caller only and answers 409 while that user's pass runs. The Nightly tab's `Run it now` uses it. Verify with `runs-routes.test.ts` cases and `ui-lib.test.ts` for the new call.
- [ ] 8.3 Run `pnpm --filter @friday/module-brain test typecheck` and the eval smoke (`pnpm --filter @friday/module-brain eval` with fixtures for one user). Verify all are green.

## 9. Calendar and Spotify are the owner's

- [ ] 9.1 Calendar: all tools `ownerOnly`; the agenda prompt context renders only for the owner; portal routes answer 403 to anyone else; the Calendar page shows the "belongs to the household owner" notice on 403. Verify with calendar tests for the member-prompt and member-route scenarios.
- [ ] 9.2 Spotify: all tools `ownerOnly`. Verify with a spotify test that a member's declarations leave them out. Run `pnpm --filter @friday/module-calendar test typecheck` and `pnpm --filter @friday/module-spotify test typecheck`.

## 10. Portal

- [ ] 10.1 The Chat, Conversations and Agents pages show only the user's own data. Remove anything that assumed shared data, such as a `user` column. Verify with `pnpm --filter @friday/portal test typecheck build`, and manually in `pnpm dev` with two seeded users.

## 11. Docs

- [ ] 11.1 README: the privacy model (what's per user, what's the household's, admins see no content, devices act for the owner, owner-only calendar and Spotify) and its limit (the operator can read `friday.db`). Also the new `forUser`, `ctx.users` and `ownerOnly` for module authors, and the `openspec/config.yaml` context. Verify by reading it against the specs, and with `openspec validate user-privacy --strict`.
- [ ] 11.2 `infra/README.md`: back up `friday.db` before deploying this change (the brain migration rebuilds its name keys). Verify the documented backup command works against a local `friday.db`.

## 12. Integration

- [ ] 12.1 An end-to-end test with the fake provider and two users. The member's chat is invisible to the owner in the API, in `brain_recall_conversations` and in the nightly pass's output into the owner's brain, and the reverse. The member can't see or run the owner's agent and gets no calendar tools. The admin owner can't open the member's conversation. Verify the test passes in `pnpm --filter @friday/core test`.
- [ ] 12.2 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`. Verify all green.
- [ ] 12.3 (user, after deploy) Back up `friday.db`, deploy, and check:
  - your history, brain and agents are all still there;
  - a member account sees an empty Chat, Conversations, Agents and Brain, and gets no calendar or Spotify;
  - the Voice PE still uses your brain;
  - your Jobs page shows no agent answers.
