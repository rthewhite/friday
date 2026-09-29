# Spec Delta

## ADDED Requirements

### Requirement: Module tables live in the core database

Tables that in-process modules create through their migrations (as specified in `module-database`) SHALL be stored in `friday.db`, next to core's tables and `module_kv`. For each module that has run migrations, `friday.db` SHALL record the module id, its current schema version and when it last changed. That record SHALL survive restarts and reloads. Module tables and records SHALL NOT be deleted when a module is disabled or removed from the module list.

#### Scenario: Pod restart
- **WHEN** module `brain` has run migrations 1 and 2 and the pod is recreated
- **THEN** its tables and rows are still present, and on startup no migration runs for `brain`

#### Scenario: Module disabled
- **WHEN** `FRIDAY_MODULES` no longer includes `brain`
- **THEN** its tables and schema version stay in `friday.db`, and enabling it again resumes from that version
