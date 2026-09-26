# Spec Delta

## ADDED Requirements

### Requirement: A module runs unchanged in-process or remotely

A `FridayModule` SHALL be runnable by the in-process host and by `runRemote` without code changes. `ctx.defineTool`, `ctx.config` and `ctx.log` SHALL have the same semantics in both hosts, with `ctx.config` reading the remote process's environment.

#### Scenario: Same module, two hosts
- **WHEN** the builtin module is loaded in-process and also via `runRemote`
- **THEN** `get_current_time` is callable as `get_current_time` and as `builtin__get_current_time` with equal results
