# Spec Delta

## Purpose

Lets the user write agents in text: instructions, a schedule, a narrow set of tools with per-tool permission, and budgets. Friday runs them unattended over the tools it already has, records every run, and parks the actions the user wants to approve.

## ADDED Requirements

### Requirement: Agents are stored definitions

Core SHALL store agent definitions in `friday.db`. A definition SHALL have:
- a `name`: kebab-case (`^[a-z][a-z0-9-]*$`), at most 40 characters, unique, and never changed after creation,
- a `description`: one line of 1 to 200 characters,
- `instructions`: markdown of 1 to 20000 characters,
- an optional `schedule`: a five-field cron expression, evaluated in `FRIDAY_TIMEZONE` as background jobs are,
- `enabled` (default `true`) and `startable` (default `false`),
- `tools`: 0 to 50 entries, each `{ pattern, mode }` with `mode` `auto` or `approve`,
- `budgets`: `maxToolCalls` (1 to 200, default 30), `maxTokens` (input and output tokens of all model calls together, 10000 to 2000000, default 200000) and `maxMinutes` (1 to 60, default 10).

Every definition SHALL be checked by the same validation when it is created or updated through any path, and again when a run starts. A definition that fails validation SHALL NOT be stored, and a run whose definition fails validation SHALL fail before any model call.

#### Scenario: Create an agent
- **WHEN** the user saves `weekly-review` with a description, instructions, schedule `0 18 * * 0` and two tool entries
- **THEN** it is stored with `enabled: true`, `startable: false` and the default budgets, and survives a restart

#### Scenario: Invalid definition
- **WHEN** a definition has the name `Weekly Review`, an empty description, or the schedule `every sunday`
- **THEN** it is refused with a message naming the problem and nothing is stored

#### Scenario: Budget out of range
- **WHEN** a definition sets `maxMinutes: 120`
- **THEN** it is refused with a message stating the allowed range

### Requirement: Tool entries select tools and their permission

A tool entry's `pattern` SHALL be an exact tool name or a pattern in which `*` matches any run of characters, including none. An agent's tools SHALL be the tools that are offered in the `agent` channel and match at least one of its entries. When a tool matches several entries, `approve` SHALL win over `auto`. Patterns that match no tool SHALL be allowed and reported as unmatched when the definition is saved and on the agents page, so an agent can be written while an MCP server is down. The `run_agent` tool SHALL NOT be offered in the `agent` channel, so an agent can never start an agent.

#### Scenario: Read tools automatically, write tools with approval
- **WHEN** an agent has entries `github__get_*` (`auto`), `github__list_*` (`auto`) and `github__create_pull_request` (`approve`)
- **THEN** its run is offered exactly the GitHub tools whose names start with `get_` or `list_`, and `github__create_pull_request`

#### Scenario: The stricter mode wins
- **WHEN** an agent has entries `github__*` (`auto`) and `github__create_pull_request` (`approve`)
- **THEN** calls to `github__create_pull_request` are parked for approval and other GitHub tools run

#### Scenario: Voice-only tool
- **WHEN** an agent has the entry `set_timer` (`auto`), and `set_timer` is offered only in `voice`
- **THEN** the entry is reported as unmatched and the run is not offered `set_timer`

#### Scenario: Server down while editing
- **WHEN** the user saves an agent with `github__*` while the `github` MCP server is failed
- **THEN** the definition is stored and `github__*` is reported as unmatched

### Requirement: An agent run is a model loop over the agent's tools

A run SHALL:
- build its system prompt from a fixed agent preamble and the agent's instructions. The preamble SHALL state the agent's name, the current local weekday, date and time with the household zone, that the agent runs unattended and nobody reads its text until the run is over, that some tools may answer that the call was queued for the user's approval and the agent must continue without that call's result, and that its final answer is the run's summary for the user;
- send as its first user message the request text when the run has one, and otherwise a fixed message asking the agent to start;
- take the agent's tools when it starts and use that set for its whole lifetime;
- call the text model (`FRIDAY_TEXT_MODEL`) in rounds, running the tool calls of each round and sending their results back, until the model answers without tool calls;
- make every tool call with channel `agent` and the run's conversation id, and answer a call that has not settled after `FRIDAY_AGENT_TOOL_TIMEOUT_MS` (default 60000) with a timeout error;
- answer a call to a tool outside the agent's tools with an error, without calling any handler.

The run SHALL be recorded as a conversation on the `agent` channel: its first user message, the model's text, and every tool call with its arguments and result. The run's summary SHALL be the model's final answer, cut to 2000 characters. Model calls SHALL be logged with the owner `agent:<name>`.

#### Scenario: A scheduled check
- **WHEN** `weekly-review` runs on its schedule, calls `calendar_list_events`, then answers "Busy week: 14 meetings, Thursday is free"
- **THEN** the run is `ok` with that summary, and its conversation holds the start message, the tool call with its result, and the answer

#### Scenario: The model reaches outside its tools
- **WHEN** the model of a run with only calendar tools calls `brain_remember`
- **THEN** the call returns an error saying the tool is not available, the brain is unchanged, and the run continues

#### Scenario: Request text
- **WHEN** a run is started with the request "only look at the friday repo"
- **THEN** the run's first user message is that text

### Requirement: Budgets bound every run

A run SHALL stop when the next model call or tool call would exceed one of its budgets: more tool calls than `maxToolCalls` in total, more than `maxTokens` input and output tokens reported for its model calls together, or a running time longer than `maxMinutes`. The calls of the round that crossed the limit SHALL NOT be run and SHALL be recorded with an error saying so. The run's outcome SHALL be `budget_exceeded`, with a summary naming the budget. Calls parked for approval SHALL count as tool calls. When `maxMinutes` passes during a model call or tool call, that call SHALL be abandoned.

#### Scenario: Too many tool calls
- **WHEN** an agent with `maxToolCalls: 5` has made 4 calls and the model asks for 3 more in one round
- **THEN** none of the 3 is run, each is recorded with an error, and the run ends `budget_exceeded` naming the tool call budget

#### Scenario: Wall time
- **WHEN** a run with `maxMinutes: 10` is still waiting for a model call after 10 minutes
- **THEN** the call is aborted and the run ends `budget_exceeded` naming the time budget

### Requirement: Runs are recorded with their outcome

Core SHALL record each run with an id, the agent name, its trigger (`schedule`, `portal`, `voice` or `chat`), the request text when given, start and end time, its outcome (`running`, `ok`, `failed`, `budget_exceeded` or `cancelled`), the error when failed, the summary, the tool calls and tokens it used, and its conversation id. A run SHALL be `failed` when the model is unavailable, blocks the request, or stops without finishing its answer. A running run SHALL be cancellable through the API; it SHALL then stop at its next model call or tool call and be `cancelled`. On shutdown, running runs SHALL be cancelled. Core SHALL keep the 50 most recent runs per agent, and SHALL NOT delete a run that still has pending actions.

#### Scenario: Model unavailable
- **WHEN** the text model is unavailable during a run
- **THEN** the run is `failed` with the error, and what was recorded so far is kept

#### Scenario: Cancelled from the portal
- **WHEN** the user cancels a running run
- **THEN** no further model call or tool call starts, and the run is `cancelled`

### Requirement: Approve tools are parked as exact calls

A call to a tool whose entry is `approve` SHALL NOT be executed. Core SHALL store it as a pending action with the run, the agent, the exact tool name and arguments, and its creation time, and SHALL answer the model with a result stating the call was queued for the user's approval and that the run must continue without its result. The user SHALL be able to approve or reject a pending action. Approving SHALL execute exactly the stored call, with no model involved, through the registry with channel `agent` and the run's conversation id, and store its result and the outcome `executed`, or `failed` with the error when the tool is no longer offered in the `agent` channel or the call fails. Rejecting SHALL mark it `rejected`. An action SHALL be approved or rejected at most once. A pending action older than 7 days SHALL become `expired`.

#### Scenario: Pull request waits for the user
- **WHEN** a run calls `github__create_pull_request` with an `approve` entry
- **THEN** no pull request is created, the run's page lists the action with its tool and arguments, and the run continues

#### Scenario: Approve later
- **WHEN** the user approves that action the next day
- **THEN** `github__create_pull_request` is called with exactly the stored arguments, and the action shows `executed` with the result

#### Scenario: Approve twice
- **WHEN** an action is approved while another approval of it is in progress, or after it was rejected
- **THEN** the second request is refused and the tool is called at most once

#### Scenario: Tool gone
- **WHEN** the user approves an action whose MCP server has been deleted
- **THEN** the action is `failed` with an error saying the tool is not available

### Requirement: Agents start on a schedule, from the portal, or by voice and chat

An enabled agent with a schedule SHALL run at each due time, as a core job named `agent-<name>` (as specified in `background-jobs`), so it is listed on the Jobs page with its next run and history, and catches up once after downtime. Starting that job from the Jobs page SHALL start a run with trigger `portal`. A disabled agent SHALL NOT run on its schedule and SHALL NOT be offered by `run_agent`, and SHALL still be startable from the portal, so a draft can be tried. An agent SHALL have at most one run in progress: any start while it runs SHALL be refused with the running run's start time, and a scheduled start SHALL be recorded in the job history as already running.

Core SHALL register a tool `run_agent` with parameters `agent` (required; one of the names of the enabled agents marked `startable`) and `request` (optional, at most 2000 characters), offered in `voice` and `chat`. Its description SHALL list each such agent with its description, and say that the run happens in the background and the result is not returned. It SHALL start the run with trigger `voice` or `chat` from the call's channel and answer at once with the agent's name and that it started, or with an error when the agent is unknown, not startable, disabled or already running. When no agent is enabled and startable, `run_agent` SHALL NOT be registered. It SHALL be registered again whenever agents change, so sessions opened afterwards see the current list.

#### Scenario: Started by voice
- **WHEN** the user says "run the weekly review for this week" and `weekly-review` is enabled and startable
- **THEN** `run_agent({ agent: "weekly-review", request: "for this week" })` starts a run with trigger `voice` and the answer says it started

#### Scenario: Not startable
- **WHEN** `security-sweep` is not marked `startable`
- **THEN** it is not in `run_agent`'s list and a call naming it returns an error

#### Scenario: Already running
- **WHEN** `weekly-review` is running since 18:00 and the user starts it in the portal at 18:02
- **THEN** the start is refused saying it has been running since 18:00

#### Scenario: Disabled agent is not scheduled
- **WHEN** `weekly-review` is disabled before Sunday 18:00
- **THEN** no run starts on Sunday, and `Run now` in the portal still starts one

### Requirement: Agents API

Core SHALL serve:
- `GET /api/agents`: every agent's definition with its unmatched patterns, whether it is running, its next scheduled run, its last run, and its number of pending actions;
- `POST /api/agents`: create, responding 201 with the agent; `PUT /api/agents/:name`: replace the definition, responding 200; `DELETE /api/agents/:name`: cancel a running run and remove the agent with its runs and actions, responding 204;
- `GET /api/agents/tools`: the tools offered in the `agent` channel with name, owner and description, for the editor;
- `POST /api/agents/:name/run` with optional `request`: start a run, responding 202 with the run id, or 409 when it is already running;
- `GET /api/agents/:name/runs`: its runs, newest first; `GET /api/agents/runs/:id`: one run with its actions; `POST /api/agents/runs/:id/cancel`;
- `POST /api/agents/actions/:id/approve` and `POST /api/agents/actions/:id/reject`, responding 409 when the action is no longer pending.

A definition that fails validation SHALL respond 400 with the message, a duplicate name 409, a changed name 400, and an unknown name or id 404.

#### Scenario: Duplicate name
- **WHEN** a client posts an agent named `weekly-review` and it already exists
- **THEN** the response is 409

#### Scenario: Delete a running agent
- **WHEN** `DELETE /api/agents/weekly-review` is called while it runs
- **THEN** the run is cancelled, the agent, its runs and its actions are removed, its job is unscheduled, and the response is 204

### Requirement: Agents page

The portal SHALL provide an `Agents` page at `/agents` listing each agent with a status dot (last outcome, or running), name, description, enabled, schedule in readable form, next run, last run, and a count of pending actions. It SHALL offer `New agent`. Opening an agent SHALL show an editor for every field of the definition, with the tool entries as rows of pattern and `auto`/`approve`, the tools each pattern matches (from `GET /api/agents/tools`) and unmatched patterns marked. It SHALL offer `Run now` with an optional request, and `Delete` with confirmation. The agent's run history SHALL list trigger, start, duration, outcome and summary. Opening a run SHALL show its request, budget use, summary or error, a link to its conversation on the Conversations page, `Cancel` while it runs, and its actions with tool, arguments, state and result, with `Approve` and `Reject` on pending ones.

#### Scenario: Approve from the run page
- **WHEN** the user opens a run with a pending `github__create_pull_request` action and chooses `Approve`
- **THEN** the action shows `executed` with the tool's result, and the agent's pending count drops by one

#### Scenario: Unmatched pattern shown
- **WHEN** an agent's entry `github__*` matches no tool
- **THEN** the editor marks that entry as matching nothing
