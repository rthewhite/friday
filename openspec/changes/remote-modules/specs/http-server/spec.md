# Spec Delta

## ADDED Requirements

### Requirement: Remote module WebSocket upgrade

The server SHALL upgrade `/ws/modules` connections and hand them to the remote module host. Other upgrade paths remain unchanged.

#### Scenario: Upgrade
- **WHEN** a client opens a WebSocket to `/ws/modules`
- **THEN** the remote module handshake begins

### Requirement: Shutdown closes remote modules

On SIGINT or SIGTERM the server SHALL close all remote module sockets with code `1001` before exiting.

#### Scenario: Shutdown with remotes connected
- **WHEN** the process receives SIGTERM while simracing is connected
- **THEN** simracing's socket is closed with 1001 and its runner will reconnect after backoff
