# Proposal

## Why

Since `auth-users`, Friday knows who is talking, but everyone still sees everything. A member's chats show up in everyone's Chat and Conversations pages. The nightly pass turns them into facts in the one shared brain, which goes into every user's prompt. `brain_recall_conversations` quotes one user's conversations to another. Every agent and every calendar is open to anyone. The household wants each person's conversations and memory to be their own: others can't see them, not even indirectly through Friday. This change adds that privacy, the step after `auth-users` in its roadmap. It combines the planned `user-chat` and `user-brain`, because private chats are only private when the brain is too.

## What Changes

- **Data ownership.** Every conversation, brain page, agent and agent run belongs to one user. Anything without a user belongs to the household owner (recorded by `auth-users`). This covers voice devices, until `voice-identity`, and all existing data, which is assigned to the owner as soon as an owner exists. **Admins can't see other users' data.** The role governs the household's setup, not people's content.
- **Conversations are private.** The Chat and Conversations pages and the conversations API list, open, search and delete only the caller's own conversations. A thread can be continued only by its own user. `ctx.conversations` is scoped to a user, so modules read one user's conversations at a time.
- **A separate brain per user.** Pages, names, aliases, tombstones, the profile (instructions and summary) and the subject page "Me" exist per user. Names are unique within a user's brain, not across brains. A new user's brain is created on first use. Everything that touches the brain works on one user's brain:
  - the brain tools, for the call's user (or the owner);
  - prompt context;
  - the Brain page and its routes;
  - the nightly pass, which runs per user over that user's conversations, with its own watermarks and runs.

  `brain_recall_conversations` searches only the caller's conversations.
- **Agents are private to their creator.** An agent records who created it. Listing, editing, running, cancelling and approving are for the creator only. A scheduled run, and an action approved later, run as the creator: their brain, their conversations, their user in tool calls. `run_agent` offers only the caller's own startable agents. Shared agents are not in this change.
- **Voice device sessions belong to the owner.** Their prompt context, tool calls and conversations carry the owner as user.
- **Owner-only tools.** A module can declare tools that only the owner gets. They are left out of other users' tool declarations (chat turns, Talk sessions, agent runs) and refused if called anyway. Calendar and Spotify declare all their tools owner-only until per-user connections exist.
- **SDK:** `ctx.users` (the owner and the list of users), user-scoped `ctx.conversations`, the owner-only tool flag, and test host support for all three.

Out of scope, each a later change:
- Per-user OAuth connections and calendars (`user-connections`).
- A device's own owner, or recognising who is speaking (`voice-identity`).
- Shared agents.
- Deleting a user together with their data.
- Comparing brains.

## Capabilities

### New Capabilities

- `data-ownership`: which user owns a piece of data, the owner fallback, assigning existing data to the owner, voice device sessions as the owner, admins not seeing others' data, `ctx.users`, and owner-only tools.

### Modified Capabilities

- `conversation-store`: listing, reading, searching and deleting are scoped to the caller's own conversations, and the Conversations page shows only those.
- `portal-chat`: the thread list and continuing a thread are limited to the user's own threads.
- `module-system`: `ctx.conversations` is scoped to a user, `ctx.users` exists, and the test host supports both.
- `tool-registry`: declarations and calls can be limited to the owner (owner-only tools), and device sessions pass the owner as user.
- `brain`: every brain requirement applies to one user's brain: pages, names, profile, subject, tools, prompt context, routes and portal.
- `brain-maintenance`: the nightly pass runs per user, over that user's conversations, with per-user watermarks, runs and review.
- `agents`: agents have a creator. Listing, editing, running and approving are limited to the creator, and scheduled runs and approved actions run as the creator.
- `calendar`: its tools are owner-only.
- `spotify`: its tools are owner-only.

## Impact

- **Core:**
  - `conversations/store.ts` (user-scoped list, get, search, delete and module view) and `app.ts` (the conversations routes).
  - `chat/engine.ts` (resuming only one's own thread) and `agents/*` (`created_by`, scoping, scheduled runs as the creator).
  - `prompt-context.ts` and `transports/ws.ts` (device sessions as the owner), `module-host.ts` (`ctx.users`, owner-only tools), `auth/users.ts` (the owner and users for `ctx.users`).
  - A core migration (`agents.created_by`, assigning existing rows to the owner once one exists).
- **SDK:** `ctx.users`, `ModuleConversations` with a user, the owner-only flag on tools, `createTestHost` options.
- **Brain module (the bulk of the work):**
  - A migration: `user_id` on pages, names, tombstones and runs, keys unique per user, one profile per user.
  - A user-scoped store; the tools, routes and prompt context per user.
  - The nightly pass looping over users, with per-user storage keys.
  - The Brain page.
- **Calendar and Spotify modules:** the owner-only flag on their tools.
- **Portal:** the Chat and Conversations pages (own data only; the "user" column goes), the Agents page (own agents), the Brain page (own brain).
- **Docs:** README (privacy model, and the limit that the operator can read `friday.db`), and the `openspec/config.yaml` context.
- **Overlap:**
  - `module-toggles` (in flight) touches `app.ts`, `module-host.ts` and adds a core migration. Merge the smaller change first; the migration number is claimed at merge time.
  - `test-gaps` (in flight) may touch the same tests. Check at apply time.
