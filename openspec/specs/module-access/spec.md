# Module Access

## Purpose

Lets admins decide, per module, MCP server and remote module, who in the household may use it: everyone or chosen users. Within a module everyone may use, it lets them keep chosen tools for the chosen users only.

## Requirements

### Requirement: Access is set per module

Every module that owns tools SHALL have an access setting, keyed by the module's id in `/api/modules`. That covers an in-process module (`sonos`), an MCP server (`mcp:home`) and a remote module (`simracing`). The setting SHALL hold:
- `mode`: `everyone` or `chosen`;
- `users`: the chosen users;
- `restricted`: tool name patterns, where `*` matches any run of characters and every other character matches itself, compared with the tool's registered name.

A module without a stored setting SHALL behave as `mode: everyone` with no chosen users and no restricted tools, which is the behaviour before this change. `core` and `builtin` SHALL have no access setting: they are always available to everyone.

#### Scenario: No setting
- **WHEN** no access has been set for `sonos`
- **THEN** every user gets the `sonos` tools, prompt context and page, as before

#### Scenario: Core can't be restricted
- **WHEN** an admin tries to set access for `core` or `builtin`
- **THEN** the request is refused and `set_timer`, `get_current_time` and `end_conversation` stay available to everyone

### Requirement: Who may use a module

A user SHALL be **allowed** a module when they are the household owner, or when they are among the module's chosen users. The owner SHALL be allowed every module, whether listed or not. Other admins SHALL NOT be allowed implicitly. A tool call or prompt without a user SHALL count as the owner's.
- With `mode: chosen`, only allowed users SHALL get the module at all.
- With `mode: everyone`, every user SHALL get the module, except for the tools that match a `restricted` pattern, which only allowed users SHALL get.

A disabled user SHALL keep their place among the chosen users, so enabling them again restores it.

#### Scenario: Chosen users only
- **WHEN** `sonos` has `mode: chosen` with chosen users `[Raymond]`, and member `Sanne` starts a chat turn
- **THEN** none of the `sonos_*` tools is offered to her, and Raymond gets them all

#### Scenario: Restricted tools
- **WHEN** `mcp:HomeAssistant` has `mode: everyone`, chosen users `[Raymond]` and restricted `["HomeAssistant__restart_ha", "HomeAssistant__*delete*"]`
- **THEN** `Sanne` is offered `HomeAssistant__get_state` and `HomeAssistant__call_service` but not `HomeAssistant__restart_ha` or `HomeAssistant__delete_automation`, and Raymond is offered all four

#### Scenario: The owner is always allowed
- **WHEN** `sonos` has `mode: chosen` with chosen users `[Sanne]`, and a voice device, which acts for the owner, opens a session
- **THEN** the `sonos_*` tools are offered

#### Scenario: Another admin isn't implied
- **WHEN** admin `Kim`, who is not the owner, is not among the chosen users of `sonos` with `mode: chosen`
- **THEN** Kim isn't offered the `sonos_*` tools

### Requirement: Module access API

`PUT /api/modules/:id/access` with body `{ mode, users, restricted }` SHALL store the access setting of module `:id` and respond 200 with the module's new entry in the shape of `/api/modules`.
- **Users:** `users` SHALL be a list of user ids.
- **Restricted:** `restricted` SHALL be a list of non-empty patterns. It may be empty.
- **Clearing:** `DELETE /api/modules/:id/access` SHALL remove the setting, back to the default, and respond 200 with the entry.
- **Admin only:** both SHALL be admin only; a member SHALL get 403.
- **400:** a body with an unknown `mode`, a user id that doesn't exist, or a pattern that is empty or not a string SHALL be refused with 400 and a message, and nothing SHALL change.
- **404:** a module that isn't in `/api/modules`, and `core` or `builtin`, SHALL respond 404.

The new setting SHALL take effect as described in "Access changes take effect without a restart".

#### Scenario: Set access
- **WHEN** an admin sends `PUT /api/modules/mcp:HomeAssistant/access` with `{ mode: "everyone", users: ["u1"], restricted: ["HomeAssistant__restart_ha"] }`
- **THEN** the response is 200 with the `mcp:HomeAssistant` entry carrying that access, and the next chat turn of a member no longer offers `HomeAssistant__restart_ha`

#### Scenario: Member tries to change access
- **WHEN** a member sends `PUT /api/modules/sonos/access`
- **THEN** the response is 403 and nothing changes

#### Scenario: Unknown user
- **WHEN** the body names a user id that doesn't exist
- **THEN** the response is 400 and the stored setting is unchanged

#### Scenario: Back to the default
- **WHEN** an admin sends `DELETE /api/modules/sonos/access`
- **THEN** the response is 200 and every user gets `sonos` again

### Requirement: A user without access gets none of it

A user who isn't allowed a module with `mode: chosen` SHALL not get it anywhere:
- **Tools:** its tools SHALL be left out of their chat turns, their browser Talk sessions, agent runs of agents they created, and `/api/tools`, and refused if called.
- **Prompt context:** it SHALL not be rendered for them.
- **Routes:** its routes SHALL answer them 403.
- **Listing:** it SHALL not be listed for them in `/api/modules`, if they are a member.

A tool that matches a `restricted` pattern SHALL likewise be left out and refused for users who aren't allowed. The module's prompt context and routes SHALL stay available to them.

#### Scenario: Tool declarations
- **WHEN** member `Sanne` requests `/api/tools` while `sonos` is `mode: chosen` without her
- **THEN** no `sonos_*` declaration is in the response

#### Scenario: Agent of a member
- **WHEN** an agent created by `Sanne` lists `HomeAssistant__*` and runs while `HomeAssistant__restart_ha` is restricted
- **THEN** the run doesn't get `HomeAssistant__restart_ha`

### Requirement: Access changes take effect without a restart

A change to a module's access SHALL apply:
- to the next chat turn, request and prompt built;
- to a voice or Talk session opened afterwards;
- to the next run of an agent.

A session opened before the change keeps its declarations. A call it makes to a tool its user is no longer allowed SHALL be refused. An action parked for approval SHALL be re-checked against the creator's access when it is approved.

#### Scenario: Open session
- **WHEN** a member's Talk session is open and an admin restricts `HomeAssistant__restart_ha`, and the session then calls it
- **THEN** the call is refused and Home Assistant is not restarted

### Requirement: Access settings outlive the module's state

A module's access setting SHALL be kept while the module is disabled, reloaded, failed or disconnected, and SHALL apply again when it comes back. Deleting an MCP server SHALL delete its access setting, so a new server with the same name starts at the default.

#### Scenario: Reconnect keeps access
- **WHEN** remote module `simracing` with `mode: chosen` disconnects and connects again
- **THEN** its tools are again only for its chosen users and the owner

#### Scenario: Deleted MCP server
- **WHEN** MCP server `home` with a stored access setting is deleted and a new server `home` is created
- **THEN** the new `mcp:home` has the default access
