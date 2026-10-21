# Design

## Context

Portal chat already does most of what an agent run needs. `ChatTurn.run` in `packages/core/src/chat/engine.ts` streams model rounds through `LlmService.streamCall`, runs the round's tool calls in parallel against `registry.declarations("chat")` with a per-call timeout, sends the results back with the parts verbatim (thought signatures kept), records everything through a `ConversationRecorder`, and stops after `MAX_TOOL_ROUNDS` (10).

Modules cannot host agents. `ModuleContext` (`packages/sdk/src/module.ts`) has no way to call other owners' tools, and `ctx.llm.generate` has no tool loop. Agents therefore live in core, next to chat and alerts.

Other relevant facts:
- Channels: `ConversationChannel` and `CHANNELS` (`packages/sdk/src/conversations.ts`, `tool.ts`) are `voice | chat`. They are used by the registry (`channels` validation, `declarations(channel)`, `callTool`'s channel check), the conversation store (column `channel TEXT`, no CHECK constraint, `InvalidQuery` for unknown channels), prompt context providers (`{ channel }`), the calendar (`ChangeSource` and `source: call.channel ?? "chat"` in `modules/calendar/src/service.ts`), the brain's `brain_recall_conversations` enum, and the portal's conversation types. Only builtin's `end_conversation` and core's six alert tools set `channels` (all `["voice"]`).
- Jobs: `Scheduler` (`packages/core/src/jobs/scheduler.ts`) registers jobs per owner and removes them per owner only (`removeOwner`). It persists the last due time per job in `job_state` and runs one catch-up after downtime.
- LLM: `LlmService` holds one FIFO `Semaphore` of `FRIDAY_LLM_CONCURRENCY` (default 2) slots for `generate` and `streamCall`. `StreamEnd.usage` reports tokens per call.
- MCP: `mcp_servers` (migration 5) has columns for include, exclude, scheduling and prefix. `McpSource` registers each tool with `registry.add(mcp:<server>, ...)`.
- Registry: `ToolRegistry` has `add`, `removeOwner`, `get`, `declarations`, `list`, `names` and `callTool`. It has no way to remove one tool.
- The latest migration is 8 (`alerts`).

## Goals / Non-Goals

**Goals:**
- One model loop shared by chat and agents, so fixes to streaming, thought signatures and tool-call handling apply to both. Chat's behaviour and tests stay unchanged.
- An agent can never call a tool outside its list, and an `approve` tool can never run without the user approving it. Both are enforced in the runtime, not by the prompt.
- Agents can't starve interactive use of the text model.
- The validation and `enabled` hooks that a later `create_agent` tool needs.

**Non-Goals:**
- Module prompt context (brain profile, agenda) in agent prompts. Agents call `brain_recall` or `calendar_list_events` when their instructions say so. This keeps a run's input fully determined by its definition and its tool results.
- Writing the outcome of an approved action back into the run's conversation. It is stored on the action. The run has finished by then, and the model never sees it.
- Retrying failed runs. A scheduled agent runs again at its next due time, as jobs do.

## Decisions

### 1. Extract the model loop from chat

A new `packages/core/src/llm/tool-loop.ts` holds the loop: stream a round, collect text and calls, run the calls, append the model parts and function responses, repeat until a round has no calls. Callers provide:
- `tools`: the declarations for this loop,
- `callTool(call)`: runs one call and returns its result (chat: the registry with channel `chat` plus the timeout; agents: permission check, then the registry or the approval queue),
- `beforeRound(state)` / `beforeCalls(calls, state)`: return a stop reason or nothing (chat: the 10-round cap; agents: the budgets),
- `onChunk`: chat forwards events to SSE, agents only record,
- `signal`: aborts the model call in flight (agents: cancel and wall time).

`ChatTurn` keeps its event mapping, recorder handling and error kinds, and delegates to the loop. Its existing tests (`chat-engine.test.ts` and the e2e test) must pass without changes. That is the check that the extraction preserved behaviour.

*Alternative*: a separate agent loop. Rejected: thought signatures, `MALFORMED_FUNCTION_CALL`/`MAX_TOKENS` handling and the settle-unrun logic would be copied, and would drift.

### 2. `agent` is a third channel

`CHANNELS` becomes `["voice", "chat", "agent"]` and `ConversationChannel` gains `agent`. Every place that branches on it:
- Registry: no code change. A tool without `channels` is offered everywhere, so all module tools (brain, calendar, travel, media) and MCP and remote tools are available to agents, subject to each agent's list. Voice-only tools stay voice-only.
- Prompt context: providers get a narrower `PromptChannel = "voice" | "chat"`, because agents don't use module context (Non-Goals). This keeps providers that test `channel === "voice"` from silently treating `agent` as chat.
- Calendar: `ChangeSource` gains `agent`, and the Changes tab shows it. `calendar_undo` keeps undoing only `voice`/`chat` changes, so a user saying "undo that" never reverts an agent's change. Agent changes are undone from the portal.
- Brain: the `channel` enum of `brain_recall_conversations` gains `agent`. Nightly extraction filters `agent` out (decision 9).
- Portal: the conversation types and the Conversations page show `agent`.

*Alternative*: no new channel; agents use `chat` and filter by their list. Rejected: there would be no way to keep an agent-only MCP server out of voice and chat, and agent runs would be mixed into chat threads.

### 3. Storage: migration 9

```
agents         name PK, description, instructions, schedule NULL, enabled, startable,
               tools_json, budgets_json, created_at, updated_at
agent_runs     id PK, agent -> agents(name) ON DELETE CASCADE, trigger, request NULL,
               started_at, ended_at NULL, outcome, error NULL, summary NULL,
               tool_calls, tokens, conversation_id NULL
agent_actions  id PK, run_id -> agent_runs(id) ON DELETE CASCADE, agent, tool, args_json,
               state (pending|approving|executed|failed|rejected|expired),
               created_at, decided_at NULL, result_json NULL, error NULL
mcp_servers    + channels_json NULL
```

`AgentStore` (definitions), `AgentRunStore` (runs and actions) in `packages/core/src/agents/`. At startup, runs still `running` become `failed` with "interrupted by a restart". Run pruning keeps 50 per agent and skips runs with a `pending` action.

### 4. One validation function

`parseAgent(body, name?)` in `agents/definition.ts` validates and normalises a definition: defaults, ranges, kebab-case name, the cron expression through the SDK's cron parser, tool entries. It throws `AgentInputError` (400). The API calls it on every write, and the runtime calls it on the stored row at run start. A future `create_agent` tool will call the same function. Matching tools is separate (`resolveTools(definition, registry)`) because unmatched patterns are allowed. It returns `{ tools: Map<name, mode>, unmatched: string[] }`.

Patterns are converted to anchored regular expressions with every character escaped except `*` (→ `.*`). Matching runs against `registry.declarations("agent")`, so voice-only tools and `run_agent` never match.

### 5. The runtime

`AgentRuntime` (`agents/runtime.ts`) owns runs:
- `start(name, trigger, request?)` returns `{ runId } | { busy: startedAt } | { unknown } | { invalid: message }`, synchronously up to registering the run, so two starts can't both pass the busy check (the same pattern as `ChatEngine.begin`). The run then continues in the background.
- Per run: an `AbortController`, a wall-time timer that aborts with reason `budget`, counters for tool calls and tokens (`StreamEnd.usage` input + output after each round), and a recorder on channel `agent`.
- Budget checks: before each model round (tokens, time) and before running a round's calls (`toolCalls + calls.length > maxToolCalls`). The calls not run are settled with an error, as chat settles unrun calls.
- `callTool`: a name outside the resolved set → `{ error: "tool <name> is not available to this agent" }`; `approve` → park (decision 7); `auto` → `registry.callTool(name, args, { channel: "agent", conversationId })` raced against `FRIDAY_AGENT_TOOL_TIMEOUT_MS` (default 60000).
- First user message: the request, or `Start your run now.` Recorded as typed user input, so the Conversations page's preview shows the request.
- System prompt: `prompts.agent` from `config.ts`, rendered at run start with the name, the local date and time from `householdTimeZone`, and the rules from the spec, then a blank line and the instructions.
- Model: `FRIDAY_TEXT_MODEL` (the `standard` tier), `thoughts: false` (nobody reads them), owner `agent:<name>` for the usage log.
- `cancel(runId)` and `stop()` (shutdown) abort the controller with reason `cancelled`.

### 6. Fairness: an agent gate in front of the shared slots

The runtime holds its own `Semaphore(1)` and acquires it before `llm.streamCall`, releasing it when the stream ends. Agent calls therefore take at most one of the shared slots, and with the default 2, chat and modules always have one. No change to `LlmService` is needed. With `FRIDAY_LLM_CONCURRENCY=1`, agents and chat share the one slot in arrival order. The README says so.

*Alternative*: priority classes inside `LlmService`'s semaphore. Rejected for now: it is more code, and a priority queue still lets a long agent stream hold every slot once it has them.

### 7. Approvals park the exact call

`callTool` for an `approve` tool inserts `agent_actions` (`pending`, exact args) and returns `{ queued: true, actionId, note: "Queued for the user's approval. It has not run; continue without its result." }`. The recorder stores that as the tool result, so the conversation shows what the model saw.

`approve(id)`: `UPDATE agent_actions SET state = 'approving' WHERE id = ? AND state = 'pending' AND created_at > <now - 7 days>`. Zero rows changed → 409 (or `expired`, set on the fly). Then `registry.callTool(tool, args, { channel: "agent", conversationId })` with the same timeout, and the state becomes `executed` with `result_json`, or `failed` with the error (including "unknown tool" when the server is gone). `reject` is the same conditional update to `rejected`. Expiry is lazy: list and approve queries mark pending actions older than 7 days `expired`. No job is needed.

Approval doesn't re-check the agent's current tool list. The user approving that exact call is the authorisation, and the action records the agent and tool it came from.

### 8. Triggers

- **Schedule**: for each enabled agent with a schedule, the runtime registers a core job `agent-<name>` through `Scheduler.register("core", spec)`. Two small scheduler additions: `unregister(jobId)` (removes one job and its timer; an in-flight handler is left to finish) and, in `JobStore`, `clearState(jobId)`. When an agent is created, updated, disabled or deleted, its job is unregistered and registered again if it still applies. When the schedule itself changed, its job state is cleared first, so a schedule edit never causes a catch-up run. The handler calls `start(name, trigger === "manual" ? "portal" : "schedule")` and awaits the run. It returns the summary, or throws with the error when the run was `failed`/`budget_exceeded`, so the Jobs page shows the outcome. When the agent is busy, it returns the summary `already running since HH:MM`. When the job's signal aborts (shutdown), it cancels the run.
- **Portal**: `POST /api/agents/:name/run`. Disabled agents are allowed here.
- **Voice and chat**: `run_agent`, owned by `core` (listed in the `core` entry of `/api/modules`), `channels: ["voice", "chat"]`. The runtime rebuilds it whenever agents change: `registry.remove("run_agent")`, then `add` with the current enum and description when at least one agent is enabled and startable. That needs `ToolRegistry.remove(name)`, a new method that emits a change like `removeOwner`. The trigger is the call context's channel.

*Alternative*: one tool per agent (`agent_<name>`). Rejected: it grows the tool count with every agent.

### 9. Brain extraction skips agent runs

`modules/brain/src/nightly/extract.ts` lists quiet conversations and skips `channel === "agent"` before counting: no model call, not handled or skipped, and the watermark moves past them. Agent text is derived from tool output, which is exactly what extraction refuses to learn from.

### 10. MCP server channels

`ServerInput.channels?: ConversationChannel[]`, validated in `parseServerInput` (non-empty, distinct, known; all three stored as unset). It is stored in `channels_json` and passed as `channels` in `McpSource`'s `registry.add`. The MCP servers tab gets three checkboxes.

### 11. API and portal

Routes in `agents/routes.ts`, mounted by `app.ts` when `deps.agents` is set (503 otherwise, like chat). The portal gets `pages/AgentsPage.vue` (list), `pages/AgentPage.vue` (editor and run history, `/agents/new` and `/agents/:name`) and a run drawer with the actions, built from `@friday/portal-ui` components like the Jobs page. The tool picker uses `GET /api/agents/tools` and matches patterns client-side with the same rule (a shared helper in `packages/portal/src/lib/agents.ts`, with the same test cases as core).

## Risks / Trade-offs

- [Prompt injection from tool output: a page, issue or email tells the agent to do something else] → Write tools should be `approve`. Agent-only MCP servers can carry narrower tokens. Runtime enforcement means an injected instruction can only reach the agent's own tools. The README's Agents section recommends `approve` for anything that writes or sends.
- [An `auto` notify tool can leak what the agent read] → This is accepted for a single-user household: the user chooses what an agent can read and where it can send. It's noted in the README.
- [Catch-up after downtime runs a missed agent once at startup] → The same as other jobs, and usually what's wanted. A schedule edit never triggers one (decision 8).
- [Agent output reaches voice through `brain_recall_conversations` snippets] → Snippets carry the agent's text, never tool results, and only when the user asks about agent runs.
- [Token use] → `maxTokens` defaults to 200000 per run. Usage is logged per `agent:<name>`.
- [A long agent round holds the agent gate] → Only agents wait for each other. Chat keeps its slot.
- [Unregistering a job while its handler runs] → The runtime's one-run-per-agent rule, not the scheduler, prevents a second run.

## Migration Plan

Migration 9 only adds tables and a nullable column, and runs at boot. Existing MCP servers have `channels_json` NULL, which means every channel, as today. Rolling back to an older image leaves the tables unused. Agent-only MCP servers would then show up in voice and chat again, because older code ignores `channels_json`. Disable such servers before rolling back.
