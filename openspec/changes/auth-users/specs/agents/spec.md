## ADDED Requirements

### Requirement: Runs and decisions record who made them

A run SHALL record the user who started it when it was started from the portal, from chat, or from a browser voice session. A scheduled run, and a run started from a voice device's session, SHALL have no user. An approved or rejected action SHALL record the user who decided it. `GET /api/agents/:name/runs`, `GET /api/agents/runs/:id` and the pending actions SHALL include `user` (`{ id, name }`, or `null`) for runs and `decidedBy` (`{ id, name }`, or `null`) for actions. Who can start runs and decide actions SHALL NOT change: every user can.

#### Scenario: Started from the portal
- **WHEN** member `u2` starts agent `weekly-review` from its page
- **THEN** the run records user `u2`

#### Scenario: Scheduled run
- **WHEN** agent `weekly-review` runs on its schedule
- **THEN** the run has no user

#### Scenario: Approval
- **WHEN** admin `u1` approves a pending action
- **THEN** the action records `u1` as `decidedBy`
