# Proposal

## Why

Every new automation in Friday means writing a module, even when the work is only orchestration: check a few tools, decide, report. The tools usually exist already (modules, MCP servers, remote modules). What's missing is a way to describe a task in text, give it a schedule and a narrow set of tools, and let Friday run it unattended. A colleague is building a general agent platform. Friday needs the household-sized version: one user, agents written by hand, with a clear boundary on which tools each agent may use and which actions need the user's approval.

## What Changes

- **Agent definitions**, stored in `friday.db` and edited in the portal (`/agents`): a kebab-case name, a one-line description, instructions (markdown), an optional cron schedule, an `enabled` flag, a `startable` flag (may be started by voice and chat), a tool list and budgets. Every definition is validated by one function when it is saved and again when each run starts.
- **Tool permissions per tool**: each entry is an exact tool name or a `*` pattern, marked `auto` (runs) or `approve` (parked for the user). An agent sees only the tools its list matches that are offered on the new `agent` channel.
- **Agent runs** in core: the model loop from portal chat, extracted and shared, with a system prompt made of a short agent preamble (date, time, household zone, "you run unattended", how approvals work) plus the agent's instructions, and the optional `request` text as the first user message. Budgets (tool calls, tokens, wall time) replace chat's fixed 10 rounds. A run is recorded as a conversation on the `agent` channel and as an agent run with its trigger, outcome, budget use and summary (the model's final answer).
- **Approvals**: a call to an `approve` tool is not executed. It is stored as a pending action with the exact tool name and arguments, the model is told it is queued, and the run continues. On the run page the user approves (Friday executes exactly that call, with no model involved, and stores the result) or rejects it. Pending actions expire after 7 days.
- **Triggers**: the cron schedule (a core job `agent-<name>`, visible on the Jobs page), `Run now` in the portal, and a new core tool `run_agent` (`agent`, optional `request`) on voice and chat, offering only agents marked `startable`. A run starts in the background and the tool answers at once. One run per agent at a time.
- **`agent` channel**: `ConversationChannel` gains `agent`. Tools without `channels` are offered in all three channels. MCP servers get an optional `channels` setting, so a server (e.g. a GitHub server with a narrow token) can be agent-only and stay out of voice and chat.
- **LLM fairness**: agent model calls take at most one of the shared text-model slots at a time, so chat and modules keep a slot while agents run.
- **Brain**: nightly extraction skips `agent` conversations, since their text is derived from tool output, not from the user.
- Results reach the user through tools in the agent's list (e.g. a notify tool from an MCP server); the runtime adds no output mechanism of its own.

Out of scope, each for a later change: an async channel that delivers approvals and other notices to the user wherever they are; fan-out (one sub-run per item) and a sandbox for autonomous coding; generating a definition from a description, including a voice/chat `create_agent` tool (this change keeps the hooks it needs: one validation function and the `enabled` flag); a per-agent model choice; agents starting agents.

## Capabilities

### New Capabilities

- `agents`: agent definitions and their validation, tool permissions, the run loop with budgets, approvals, triggers including `run_agent`, the `/api/agents` API and the portal's Agents page.

### Modified Capabilities

- `tool-registry`: tools may be offered in the `agent` channel; tools without `channels` are offered in voice, chat and agent.
- `conversation-store`: conversations may have channel `agent`, in the listing filter, search and the Conversations page.
- `mcp-tools`: an MCP server definition may set `channels`, applied to all its tools.
- `brain-maintenance`: extraction skips `agent` conversations.
- `brain`: `brain_recall_conversations` accepts `agent` as a channel filter, so Friday can say what an agent reported.
- `portal-shell`: the sidebar's `Assistant` section gains `Agents`.
- `module-llm`: agent runs hold at most one of the shared concurrency slots at a time.

## Impact

- New `packages/core/src/agents/` (store, validation, runner, approvals, tools, routes) and migration 9 (`agents`, `agent_runs`, `agent_actions`, and `mcp_servers.channels_json`).
- `packages/core/src/chat/engine.ts`: the model and tool loop moves into a shared module used by chat and agents. Chat behaviour does not change.
- `packages/sdk/src/tool.ts` and `conversations.ts`: `CHANNELS` and `ConversationChannel` gain `agent`. Modules that branch on `call.channel` must handle it: the calendar records changes with source `agent` (its `ChangeSource` type and Changes tab), and `brain_recall_conversations` accepts `agent` as a channel filter.
- `packages/core/src/tools/mcp.ts`, `mcp-store.ts`: server `channels`. The portal's MCP servers tab gets a channels control.
- `packages/core/src/llm/service.ts`: an agent gate in front of the shared slots.
- `packages/core/src/app.ts`, `server.ts`: wiring, `/api/agents` routes.
- Portal: `/agents` list and editor, run history with pending actions, the sidebar entry, `agent` in the Conversations channel filter.
- `packages/sdk/src/registry.ts`: `remove(name)`, so `run_agent` can be rebuilt without touching core's other tools. `packages/core/src/jobs/`: unregister one job and clear its state.
- Docs: README (Agents), `.env.example` (`FRIDAY_AGENT_TOOL_TIMEOUT_MS`), `openspec/config.yaml` context.
- No other change is in flight, so nothing conflicts. The change claims migration 9 at merge.
