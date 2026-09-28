# Spec Delta

## MODIFIED Requirements

### Requirement: Connect URL may carry a device identifier

The server SHALL accept an optional `device` query parameter on `/ws/audio`, log it with the connection, and record it as the device of the connection's conversation. Connections without the parameter SHALL behave exactly as before, and their conversations SHALL have no device. The server SHALL ignore unknown query parameters.

#### Scenario: Device identifier present
- **WHEN** a client connects to `/ws/audio?device=kitchen`
- **THEN** the connection is accepted, the log line for the session includes `kitchen`, and the recorded conversation has device `kitchen`

#### Scenario: No identifier
- **WHEN** a client connects to `/ws/audio` without query parameters
- **THEN** the connection is accepted as today and the recorded conversation has no device

#### Scenario: Unknown parameter
- **WHEN** a client connects with a query parameter the server does not recognise
- **THEN** the connection is accepted and the parameter is ignored
