# Tasks

## 1. The `agent` channel

- [x] 1.1 Add `agent` to `ConversationChannel` and `CHANNELS` in `@friday/sdk`, and add `ToolRegistry.remove(name)`. Verify with `packages/sdk/test/registry.test.ts`: a tool without `channels` is in `declarations("agent")`, a voice-only tool is not, `channels: ["agent"]` is accepted and `["email"]` refused, `remove` removes one tool across owners and notifies once, and an unknown name returns false without notifying
- [x] 1.2 Give prompt context providers a `PromptChannel = "voice" | "chat"` type in `packages/sdk/src/prompt.ts` and `packages/core/src/prompt-context.ts`, so providers never see `agent`. Verify with `pnpm --filter @friday/sdk typecheck`, `pnpm --filter @friday/core typecheck` and the existing `prompt.test.ts`
- [x] 1.3 Accept `agent` in the conversation store (list filter, search, `InvalidQuery` for other values) and in `GET /api/conversations?channel=`, and count an agent run's live recorder in the 409 on delete. Verify with `conversations-store.test.ts` (an `agent` conversation is listed and searched by channel, `email` refused) and `platform-api.test.ts` (`?channel=agent` lists only agent conversations)
- [x] 1.4 Show `agent` in the portal's conversation types and the Conversations page (channel column, no `Open in Chat`). Verify with `pnpm --filter @friday/portal typecheck` and by opening an agent conversation in the dev portal once group 5 has produced one
- [x] 1.5 Calendar: add `agent` to `ChangeSource` and its UI type, show it in the Changes tab, and scope `calendar_undo`: on voice and chat it reverts only `voice`/`chat` changes, in an agent run only `agent` changes. Verify with `modules/calendar/test/changes.test.ts`: a change made with channel `agent` is stored with source `agent`, "undo that" by voice skips the agent's newer change, and an agent's `calendar_undo` leaves a voice change alone
- [x] 1.6 Brain: accept `agent` in `brain_recall_conversations`' channel enum, and skip `agent` conversations in nightly extraction (no model call, not counted, watermark moves past). Verify with `modules/brain/test/tools.test.ts` (channel `agent` filter) and `extract.test.ts` (an agent conversation with a tool result naming a sister adds no note, makes no model call and is not considered again)

## 2. MCP server channels

- [x] 2.1 Add migration 9's `mcp_servers.channels_json` column, `channels` in `ServerInput`/`parseServerInput` (non-empty, distinct, known; all three stored as unset), and pass it to `registry.add` in `McpSource`. Verify with `mcp-store.test.ts` (round trip, `[]` and `["email"]` refused, all three stored as unset), `mcp.test.ts` (an agent-only server's tools are absent from `declarations("voice")` and `declarations("chat")`) and `mcp-api.test.ts` (400 on invalid channels)
- [x] 2.2 Add the voice/chat/agent checkboxes to `McpServersTab.vue` and show the channels in the server list. Verify with `pnpm --filter @friday/portal typecheck` and by making a server agent-only in the portal (a local MCP fixture): it is stored with `channels: ["agent"]`, loads, shows `agent` in the list, and its tools appear in `GET /api/agents/tools`. (The Chat page shows no tool list; that voice and chat don't get the tools is covered by `mcp.test.ts`.)

## 3. Shared model loop

- [x] 3.1 Extract the model and tool loop from `chat/engine.ts` into `packages/core/src/llm/tool-loop.ts` (tools, `callTool`, `beforeRound`/`beforeCalls` stop hooks, chunk callback, signal, settling unrun calls), and make `ChatTurn` use it. Verify that `chat-engine.test.ts`, `chat-api.test.ts` and `chat-history.test.ts` pass unchanged, and add `packages/core/test/tool-loop.test.ts` with a fake stream for a stop from `beforeCalls`, an abort during a model call, and parts sent back verbatim

## 4. Definitions and storage

- [x] 4.1 Add the rest of migration 9 (`agents`, `agent_runs`, `agent_actions`) and `AgentStore`/`AgentRunStore` in `packages/core/src/agents/` (CRUD, runs with outcome and counters, pruning to 50 per agent while keeping runs with pending actions, `running` runs failed at startup). Verify with `packages/core/test/agent-store.test.ts`
- [x] 4.2 Add `parseAgent(body, name?)` and `resolveTools(definition, registry)` (the escaped `*` pattern rule, `approve` wins, unmatched list, matched against `declarations("agent")`). Verify with `packages/core/test/agent-definition.test.ts`: defaults, every range and format error from the spec, a renamed agent refused, `github__*` + `github__create_pull_request` (approve wins), a voice-only tool unmatched, a regex character in a pattern matched literally

## 5. Runtime

- [x] 5.1 Add `prompts.agent` to `config.ts` and `FRIDAY_AGENT_TOOL_TIMEOUT_MS` (default 60000) to the core settings and `.env.example`. Verify with `chat-config.test.ts`: the rendered preamble names the agent, the local weekday, date, time and zone, the unattended rule and the approval rule, and the `.env.example` check passes
- [x] 5.2 Add `AgentRuntime.start/cancel/stop` with the shared loop, the agent gate (`Semaphore(1)` before `streamCall`), the first message (request or the fixed start message), the conversation on channel `agent`, owner `agent:<name>`, tool calls with channel `agent` and the conversation id, refusal of tools outside the set, the tool timeout, the summary (final answer, 2000 characters), outcomes `ok`/`failed`/`cancelled`, and one run per agent. Verify with `packages/core/test/agent-runtime.test.ts` on a fake model and registry: the weekly-review scenario, a call outside the set refused without calling the handler, the request as first message, a busy start refused with the start time, cancel, model unavailable → `failed` with the recording kept, and two agents running while a chat call starts at once
- [x] 5.3 Enforce budgets: tool calls (round over the limit not run, settled with an error), tokens (from `usage`), wall time (aborts the call in flight), outcome `budget_exceeded` with the budget named. Verify with `agent-runtime.test.ts`: `maxToolCalls: 5` with 4 made and 3 asked, a token budget crossed after a round, `maxMinutes` passing during a slow fake model call
- [x] 5.4 Park `approve` calls as pending actions with the queued result, and add `approve`/`reject` (conditional state update, execution with channel `agent` and the timeout, `executed`/`failed`, lazy expiry after 7 days). Verify with `packages/core/test/agent-approvals.test.ts`: the pull request scenario (handler not called, action pending, run continues), approve calls the handler once with the stored args, a concurrent second approve and approve after reject get a conflict, approve with the tool removed → `failed`, an 8-day-old action → `expired`, and parked calls count toward `maxToolCalls`

## 6. Triggers

- [x] 6.1 Add `Scheduler.unregister(jobId)` and `JobStore.clearState(jobId)` (and `deleteRuns(jobId)` for a deleted agent's job history). Verify with `jobs.test.ts`: an unregistered job stops firing and leaves the list, another job of the same owner keeps firing, and a cleared job registered again with a schedule whose last due time has passed does not catch up
- [x] 6.2 Register the core job `agent-<name>` for each enabled scheduled agent, and re-register it on create, update, disable and delete (clearing its state when the schedule changed). The handler starts the run (`schedule`, or `portal` for a manual job run), awaits it, returns the summary or throws on failure, reports "already running since HH:MM" when busy, and cancels on abort. Verify with `agent-triggers.test.ts` on a fake clock: a run on schedule, no run after disable, a schedule change without a catch-up, the busy summary, the Jobs page trigger mapped to `portal`
- [x] 6.3 Add the core-owned `run_agent` tool (voice and chat, enum and description of enabled startable agents, optional `request` up to 2000 characters, trigger from the call's channel), rebuilt on every agent change with `registry.remove`, absent when no agent is startable. Verify with `packages/core/test/agent-tools.test.ts`: the voice scenario, not startable and disabled refused, busy refused, not in `declarations("agent")`, removed when the last startable agent is disabled, and owned by `core` (so `/api/modules` lists it in the core entry)

## 7. API

- [x] 7.1 Add `agents/routes.ts` with every route in the spec, mounted in `app.ts` (503 without `deps.agents`), and wire `AgentStore`, `AgentRuntime`, the jobs and `run_agent` in `server.ts` (stop on shutdown). Verify with `packages/core/test/agents-api.test.ts`: create 201 with `unmatched`, invalid 400, duplicate 409, rename 400, unknown 404, `GET /api/agents/tools` without voice-only tools, run 202 then 409 while running, runs listed newest first, cancel, approve/reject 409 when not pending, and delete of a running agent (run cancelled, job gone, 204)

## 8. Portal

- [x] 8.1 Add `packages/portal/src/lib/agents.ts` (API client, the pattern rule, readable schedule) and the `Agents` nav item under Assistant (highlighted on every `/agents` route). Verify with `packages/portal/test/agents.test.ts` (the same pattern cases as core) and `pnpm --filter @friday/portal typecheck`
- [x] 8.2 Add the Agents list page and the agent editor (`/agents`, `/agents/new`, `/agents/:name`): every field, tool rows with `auto`/`approve`, the tools each pattern matches, unmatched marked, `Run now` with a request, `Delete` with confirmation, and the run history. Verify in the portal on a free port, driven by headless Chrome, by creating an agent with an unmatched pattern, saving, and running it (without a Gemini key the run fails and shows that error)
- [x] 8.3 Add the run drawer: request, budget use, summary or error, conversation link (`/conversations?id=`), `Cancel` while running, and actions with `Approve`/`Reject`. Verify in the portal with a pending action (seeded in the scratch database, since no model was available): the action is listed, `Approve` shows `executed` with the result, and the pending count drops

## 9. Docs and context

- [x] 9.1 Update the README (an Agents section: definitions, tool patterns and modes, `approve` for anything that writes or sends, the `agent` channel and agent-only MCP servers, budgets, `run_agent`, sharing the LLM slots and `FRIDAY_LLM_CONCURRENCY=1`, rolling back with agent-only servers), `.env.example`, and `openspec/config.yaml` context (agents paragraph, the channel list, the MCP `channels` setting, migration 9). Leave `deploy/k8s.yaml` as is unless a value is set there. Verify by reading the diff and running `pnpm --filter @friday/core test` (the `.env.example` check)

## 10. Integration

- [x] 10.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree. Verify it is green
- [ ] 10.2 With a dev server on a free port, create an agent with `calendar_list_events` (`auto`) and a notify or other write tool (`approve`), mark it startable, and say "run <agent>" in the Talk page. Verify the tool answers at once, the run appears with trigger `voice`, the write is parked, the conversation is on the `agent` channel, and approving it runs the tool once
