## ADDED Requirements

### Requirement: Agents belong to their creator

An agent SHALL record the user who created it; agents that existed before users SHALL belong to the household owner. Only the creator SHALL see, edit, delete, run, cancel or decide an agent's runs and actions: for anyone else, its definition, runs and actions SHALL respond 404 and SHALL be left out of every listing. Every run of an agent, whether scheduled, started from the portal, chat or voice, or an approved action executed later, SHALL run as the creator: its tool calls SHALL carry the creator as user and its conversation SHALL belong to the creator. Agent names SHALL stay unique across the household; creating an agent whose name another user holds SHALL respond 409 with a message that doesn't reveal the other agent.

#### Scenario: Member can't see the owner's agent
- **WHEN** member `Sanne` lists agents, or requests `weekly-review`, which the owner created
- **THEN** it isn't listed, and the request responds 404

#### Scenario: Scheduled run acts for the creator
- **WHEN** the owner's agent `weekly-review` runs on its schedule and calls `brain_recall`
- **THEN** the call carries the owner and searches the owner's brain

## MODIFIED Requirements

### Requirement: Agents API

Core SHALL serve:
- `GET /api/agents`: the requesting user's agents, each definition with its unmatched patterns, whether it is running, its next scheduled run, its last run, and its number of pending actions;
- `POST /api/agents`: create, responding 201 with the agent; `PUT /api/agents/:name`: replace the definition, responding 200; `DELETE /api/agents/:name`: cancel a running run and remove the agent with its runs and actions, responding 204;
- `GET /api/agents/tools`: the tools offered in the `agent` channel with name, owner and description, for the editor;
- `POST /api/agents/:name/run` with optional `request`: start a run, responding 202 with the run id, or 409 when it is already running;
- `GET /api/agents/:name/runs`: its runs, newest first; `GET /api/agents/runs/:id`: one run with its actions; `POST /api/agents/runs/:id/cancel`;
- `POST /api/agents/actions/:id/approve` and `POST /api/agents/actions/:id/reject`, responding 409 when the action is no longer pending.

A definition that fails validation SHALL respond 400 with the message, a duplicate name 409, a changed name 400, and an unknown name or id, or another user's agent, run or action, 404.

#### Scenario: Duplicate name
- **WHEN** a client posts an agent named `weekly-review` and it already exists
- **THEN** the response is 409

#### Scenario: Delete a running agent
- **WHEN** `DELETE /api/agents/weekly-review` is called while it runs
- **THEN** the run is cancelled, the agent, its runs and its actions are removed, its job is unscheduled, and the response is 204

### Requirement: Agents page

The portal SHALL provide an `Agents` page at `/agents` listing each of the logged-in user's agents with a status dot (last outcome, or running), name, description, enabled, schedule in readable form, next run, last run, and a count of pending actions. It SHALL offer `New agent`. Opening an agent SHALL show an editor for every field of the definition, with the tool entries as rows of pattern and `auto`/`approve`, the tools each pattern matches (from `GET /api/agents/tools`) and unmatched patterns marked. It SHALL offer `Run now` with an optional request, and `Delete` with confirmation. The agent's run history SHALL list trigger, start, duration, outcome and summary. Opening a run SHALL show its request, budget use, summary or error, a link to its conversation on the Conversations page, `Cancel` while it runs, and its actions with tool, arguments, state and result, with `Approve` and `Reject` on pending ones.

#### Scenario: Approve from the run page
- **WHEN** the user opens a run with a pending `github__create_pull_request` action and chooses `Approve`
- **THEN** the action shows `executed` with the tool's result, and the agent's pending count drops by one

#### Scenario: Unmatched pattern shown
- **WHEN** an agent's entry `github__*` matches no tool
- **THEN** the editor marks that entry as matching nothing

### Requirement: Runs and decisions record who made them

A run SHALL record the agent's creator as its user, however it was started. An approved or rejected action SHALL record the user who decided it. `GET /api/agents/:name/runs`, `GET /api/agents/runs/:id` and the pending actions SHALL include `user` (`{ id, name }`, or `null`) for runs and `decidedBy` (`{ id, name }`, or `null`) for actions. Only the creator can start runs and decide actions (as specified in "Agents belong to their creator").

#### Scenario: Started from the portal
- **WHEN** member `u2` starts their agent `weekly-review` from its page
- **THEN** the run records user `u2`

#### Scenario: Scheduled run
- **WHEN** `u2`'s agent `weekly-review` runs on its schedule
- **THEN** the run records user `u2`

#### Scenario: Approval
- **WHEN** `u1` approves a pending action of their agent
- **THEN** the action records `u1` as `decidedBy`

### Requirement: Agents start on a schedule, from the portal, or by voice and chat

An enabled agent with a schedule SHALL run at each due time, as a core job named `agent-<name>` (as specified in `background-jobs`), so it is listed on the Jobs page with its next run and history, and catches up once after downtime. The job's recorded summary SHALL hold only the run's outcome, never the agent's answer. Starting that job from the Jobs page SHALL start a run with trigger `portal`, and SHALL be refused (403) for anyone but the agent's creator. A disabled agent SHALL NOT run on its schedule and SHALL NOT be offered by `run_agent`, and SHALL still be startable from the portal, so a draft can be tried. An agent SHALL have at most one run in progress: any start while it runs SHALL be refused with the running run's start time, and a scheduled start SHALL be recorded in the job history as already running.

Core SHALL register a tool `run_agent` with parameters `agent` (required; the name of one of the caller's enabled agents marked `startable`) and `request` (optional, at most 2000 characters), offered in `voice` and `chat`. Its description SHALL say that the run happens in the background and the result is not returned, and SHALL NOT list agents. Core SHALL add prompt context listing the prompt's user's enabled, startable agents with their descriptions, and nothing when they have none. It SHALL start the run with trigger `voice` or `chat` from the call's channel and answer at once with the agent's name and that it started, or with an error when the agent is unknown, not the caller's, not startable, disabled or already running. When no agent is enabled and startable, `run_agent` SHALL NOT be registered. It SHALL be registered again whenever agents change, so sessions opened afterwards see the current list.

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

#### Scenario: Another user's agent
- **WHEN** member `Sanne` says "run the weekly review" and `weekly-review` is the owner's
- **THEN** `run_agent` answers with an error, and Sanne's prompt never listed the owner's agents

#### Scenario: Jobs page shows no answers
- **WHEN** an admin opens the Jobs page after the owner's `weekly-review` ran
- **THEN** its run history shows the outcome, not the agent's summary
