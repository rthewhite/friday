# Design

> From an explore session on 2026-10-27. The decisions below were confirmed with the user; "Proposed defaults" are mine, open to change while writing specs.

## Context

See proposal.md for the motivation.

- `auth-users` gave every request a user (`req.user`, `ToolCallContext.user`, `PromptContextInfo.user`). It records attribution (`conversations.user_id`, `agent_runs.user_id`, `agent_actions.decided_by`, `brain__revisions.user_id/user_name`) and the household owner (`auth_owner`). Nothing is filtered by user yet.
- Conversation text reaches other users in four ways:
  - the conversations API and the Chat and Conversations pages;
  - `brain_recall_conversations` (`ctx.conversations.search`);
  - the nightly pass (`ctx.conversations.list/get`) writing into the one shared brain that every prompt includes;
  - agents, which anyone can list, run and approve.
- The brain assumes one brain throughout:
  - one profile row (fixed id `profile`, a unique index on `is_profile`);
  - `brain__names.key` and `brain__tombstones.key` as primary keys (names unique across the brain);
  - one set of nightly runs and `ctx.storage` watermarks;
  - `PROFILE_ID` and the subject used in the store, routes, tools and nightly code (about 3,000 lines).
- Agent jobs report the run's summary, the agent's final answer, as their job summary. The admin-only Jobs page shows it.
- Calendar (the owner's iCloud and work intake) and Spotify (the owner's OAuth connection) are open to everyone through chat.
- Voice device sessions have no user (`auth-users`); `voice-identity` will give devices an owner later.

## Goals / Non-Goals

**Goals:**
- What one user says and remembers can't reach another user, through any page, API, tool, prompt or job.
- One rule for data without a user, so the later `voice-identity` and shared agents can replace pieces of it without a new model.
- The brain's behaviour per user is exactly today's behaviour, only scoped.

**Non-Goals:**
- Per-user calendars and OAuth connections (`user-connections`), device owners (`voice-identity`), shared agents, deleting a user and their data, comparing brains.
- Privacy against the operator: whoever runs the server can read `friday.db`.

## Decisions (confirmed)

| # | Decision |
|---|---|
| D1 | Privacy is the goal: others can't see your data, not even indirectly through Friday. |
| D2 | `user-chat` and `user-brain` become one change, `user-privacy`, with agents included. |
| D3 | Voice device sessions belong to the household owner until `voice-identity`. |
| D4 | All existing data (conversations, agents, agent runs, the brain) goes to the owner. |
| D5 | Agents are private to their creator: list, edit, run, approve. A scheduled run, and an action approved later, run as the creator. Shared agents may come later. |
| D6 | Admins can't see other users' data. The role is for the household's setup, not people's content. |
| D7 | Calendar and Spotify are owner-only until per-user connections exist. |

## Decisions (proposed defaults)

### One ownership rule: user, else the owner

```
 who owns X?   X.user_id                       (set when written: chat, Talk, agent, portal)
               else the household owner         (devices, legacy rows; D3, D4)

 owner = auth_owner (first admin to log in)
         | dev mode: the dev user stands in, so `pnpm dev` behaves like a household of one
         | no owner yet (fresh install, before the first admin login): unowned data stays unowned
```

Voice device sessions are given the owner as their user explicitly: prompt context, tool calls and the recorder's `userId`. Device data is then never "unowned", and `voice-identity` only has to change who the device's user is.

### Assigning existing data once there is an owner

The owner may not exist when a migration runs (a fresh install, or dev before the first login), and a module may not read core's tables. So assignment is an event, not a migration:
- Core assigns `user_id IS NULL` rows of `conversations`, `agent_runs` and `agents.created_by` to the owner at startup, and again right after the owner is recorded.
- Modules learn the owner through `ctx.users.owner()` and `ctx.users.onOwner(handler)`. The brain does the same for its tables in its own transaction, at init and on the event.

All of it is idempotent: only `NULL` rows change. New writes always set a user, so it happens once in practice.

### SDK

```
 ctx.users.owner()            -> { id, name } | undefined
 ctx.users.list()             -> { id, name }[]          active (not disabled) users
 ctx.users.onOwner(handler)   -> unsubscribe              fires once when the owner is recorded
 ctx.conversations.forUser(id) -> { list, get, search }   one user's conversations only
 ctx.conversations.onQuiet(h)  -> QuietEvent gains userId
 Tool.ownerOnly?: true
 createTestHost({ user, users, owner })
```

`ctx.conversations` loses its unscoped `list`, `get` and `search`. The brain is their only user, and an unscoped read is exactly the leak this change closes. `get` through `forUser` returns `undefined` for another user's conversation.

### Conversations

The store gets a user on every read path (list, get, search, delete). The routes pass `req.user.id`. Another user's conversation is a 404, not a 403, so ids can't be probed. A chat thread can be continued only by its own user (404 otherwise). The `user` column on the Conversations page goes: every row is yours. Retention stays global.

### Brain per user

- **Schema (brain migration 5):**
  - `user_id` on `brain__pages`, `brain__runs`, `brain__names` and `brain__tombstones`, with names and tombstones rebuilt with primary key `(user_id, key)`;
  - the one-profile index becomes one profile per user;
  - `PROFILE_ID` stops being a row id: the profile is "the row with `is_profile = 1` for this user", and the routes keep `pages/profile` as an alias for the caller's profile.
  - Revision ids stay global (AUTOINCREMENT), so "revisions since N" keeps working, filtered by user.
- **Store:** `BrainStore` becomes per user (`brain.forUser(id)`). Every query carries the user, and the store never takes a page id from another user. A user's brain (profile and "Me") is created on first use, with the user's name as the subject's starting name.
- **Tools** act for `call.user`. A call without one (none remain once devices are the owner's) falls back to the owner.
- **Prompt context** renders for `info.user`.
- **Routes** act for `req.user`.
- **Nightly pass:** one job, `brain/nightly`, loops over `ctx.users.list()`, one user at a time:
  - extraction reads `ctx.conversations.forUser(id)`;
  - consolidation and summary work on that user's store;
  - `ctx.storage` keys get a user prefix (existing keys become the owner's), and each run in `brain__runs` belongs to its user;
  - one user's failure doesn't stop the others, and the job's summary has counts only.
- **Run now:** the Nightly tab gets its own route that runs the pass for the requesting user only. Members can then use it, and the admin-only jobs API is no longer involved.

### Agents

- `agents.created_by`, assigned to the owner for existing agents.
- Agent names stay unique across the household. They name a core job (`agent-<name>`), so a member can't reuse a name another user holds. The API answers "name taken" without saying by whom.
- The agents API filters by the creator and answers 404 for anyone else's agent, run or action.
- Scheduled runs, `run_agent` and approved actions run as the creator.
- **`run_agent` no longer lists agents in its description.** That description went into every user's tool declarations, with every startable agent's name and description. Instead, core adds prompt context with the prompt's user's own startable agents, and `run_agent` refuses another user's agent.
- **Jobs page:** an agent job's summary carries only the outcome (`ok`, `failed`, `budget_exceeded`), never the agent's answer. "Run now" on another user's agent job is refused, so an admin can't make an agent run in someone else's scope.

### Owner-only tools

- The registry is given a way to tell whether a user is the owner. `declarations(channel, user)` leaves `ownerOnly` tools out for anyone else, and `callTool` refuses them with an error saying they're only for the household owner.
- A call without a user is refused too. Since devices act as the owner and agents as their creator, that only happens in tests, and the test host treats its default user as the owner.
- Voice sessions snapshot their declarations at open, when the user is known. Chat builds them per turn, and agents resolve their tools for the creator.
- Calendar and Spotify set `ownerOnly` on all their tools. Calendar also puts the agenda into every prompt and has portal routes, so its prompt context renders only for the owner and its routes answer 403 to anyone else.

### Admins see no content

There's no admin path to another user's conversations, brain, agents or runs: the API scoping applies to admins too. The Users page shows people, not content. The README states the limit: the operator can read `friday.db`.

## Risks / Trade-offs

- [The brain migration rewrites the keys of `brain__names` and `brain__tombstones`] → One transaction, tested against a copy of a real brain, and a backup step in the deploy notes.
- [The nightly pass costs grow with the number of users] → One user at a time on the existing LLM gate. A household is a few people.
- [Somebody talks to the kitchen Voice PE and it lands in the owner's history and brain] → Accepted until `voice-identity` (D3).
- [A member can't reuse an agent name another user holds] → Accepted, and the message doesn't reveal the other agent.
- [A module keeps an unscoped view of conversations by caching] → The SDK no longer offers one. The brain is the only reader, and it's rewritten here.

## Migration Plan

1. Deploy. Core and brain migrations add the columns.
2. At startup the owner (already recorded in production) receives every unowned conversation, agent, run and the existing brain.
3. Members start with an empty brain and no history.

Rollback: redeploy the previous image. The old code ignores the new columns, but it would show everyone everything again, and a brain whose names were rebuilt per user still works as one brain only while it has a single user. Back up `friday.db` before deploying.

## Open Questions

- The wording of the empty-brain prompt line for a new user ("you don't know this user yet").
