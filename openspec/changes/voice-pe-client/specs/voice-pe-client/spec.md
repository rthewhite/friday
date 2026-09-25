# Spec Delta

## Purpose

Firmware behaviour of a Home Assistant Voice Preview Edition running as a Friday client: press-to-talk session lifecycle, microphone streaming, speaker playback, LED feedback and error handling over the Friday WebSocket audio protocol.

## ADDED Requirements

### Requirement: Session is controlled by the top button

The device SHALL start a Friday session when the top button is single-clicked while idle, and SHALL end the current session when the top button is single-clicked in any other state. Other button gestures (long press, double or triple click) SHALL NOT affect the Friday session.

#### Scenario: Start from idle
- **WHEN** the device is idle and the button is single-clicked
- **THEN** the device connects to the Friday server and begins streaming microphone audio

#### Scenario: Stop while listening or speaking
- **WHEN** a session is active and the button is single-clicked
- **THEN** the microphone stops, the connection is closed, and the device returns to idle

#### Scenario: Click while connecting
- **WHEN** the device is still connecting and the button is single-clicked
- **THEN** the connection attempt is abandoned and the device returns to idle

#### Scenario: Other gestures
- **WHEN** the button is long-pressed or multi-clicked
- **THEN** the Friday session state is unchanged

### Requirement: Session connects to a configured Friday server

The device SHALL connect over plain WebSocket to a server address set in the device configuration, with a device identifier included as a query parameter on the connect URL. No credential SHALL be sent in this version.

#### Scenario: Connect URL
- **WHEN** a session starts
- **THEN** the device opens a WebSocket to `<configured base url>/ws/audio?device=<device id>`

#### Scenario: Server unreachable
- **WHEN** the connection cannot be established within a bounded time
- **THEN** the device enters the error state and returns to idle without retrying

#### Scenario: Server rejects the connection
- **WHEN** the server closes the socket during or right after the handshake
- **THEN** the device enters the error state and returns to idle

### Requirement: Microphone audio is streamed while a session is active

While a session is active the device SHALL stream one channel of echo-cancelled microphone audio as 16 kHz mono signed 16-bit little-endian PCM in binary WebSocket frames. Capture SHALL run in both the listening and speaking states so the user can interrupt Friday.

#### Scenario: Listening
- **WHEN** the session is active
- **THEN** microphone audio is sent to the server continuously as binary frames

#### Scenario: Speaking
- **WHEN** Friday is playing audio
- **THEN** microphone streaming continues so barge-in is possible

#### Scenario: Network stall
- **WHEN** frames cannot be sent for a period longer than the device's send buffer holds
- **THEN** the oldest unsent audio is discarded and capture continues without glitching

#### Scenario: Hardware mute engaged
- **WHEN** the hardware mute switch is on and the button is clicked to start a session
- **THEN** the device does not start and shows the error state

#### Scenario: Hardware mute during a session
- **WHEN** the hardware mute switch is engaged during a session
- **THEN** microphone audio sent to the server is silent for as long as the switch is engaged

### Requirement: Server audio is played through the speaker

The device SHALL play binary frames from the server as 24 kHz mono signed 16-bit little-endian PCM through the on-board speaker, converting to the speaker's native format. Playback SHALL respect the device volume dial and mute state. All Friday playback SHALL go through the same output path as other device audio so echo cancellation remains effective.

#### Scenario: Speech arrives
- **WHEN** binary frames arrive from the server
- **THEN** they are queued and played in order without gaps

#### Scenario: Speaking state
- **WHEN** the first audio frame of a turn arrives
- **THEN** the device enters the speaking state

#### Scenario: Turn complete
- **WHEN** a `turn_complete` event arrives and queued audio has finished playing
- **THEN** the device returns to the listening state

#### Scenario: Playback buffer full
- **WHEN** audio arrives faster than it can be played and the buffer is full
- **THEN** the frame is dropped and a warning is logged rather than blocking the connection

### Requirement: Interruption flushes playback

On an `interrupted` event the device SHALL immediately discard all queued and playing audio and return to the listening state.

#### Scenario: User interrupts Friday
- **WHEN** an `interrupted` event arrives while audio is playing
- **THEN** playback stops within a fraction of a second, the queue is emptied, and the device shows the listening state

### Requirement: Server-initiated close drains playback

On a `closed` event the device SHALL stop the microphone at once, let already-queued audio finish, then close the connection and return to idle. A drain that takes longer than a bounded time SHALL be cut off.

#### Scenario: Friday ends the conversation
- **WHEN** a `closed` event arrives while speech is still queued
- **THEN** capture stops immediately, the remaining speech plays to the end, and the device goes idle

#### Scenario: Connection drops without a closed event
- **WHEN** the WebSocket closes or errors unexpectedly during a session
- **THEN** the device stops the microphone, discards queued audio, and shows the error state before returning to idle

### Requirement: Session state is exposed to the device configuration

The device SHALL expose its session state (idle, connecting, listening, speaking, error) to the ESPHome configuration through a trigger so LED behaviour can be defined in YAML, and SHALL expose start, stop and toggle actions.

#### Scenario: State change
- **WHEN** the session state changes
- **THEN** the configured on-state automation runs with the new state

#### Scenario: LED feedback
- **WHEN** the device is connecting, listening, speaking, or in error
- **THEN** the LED ring shows a distinct pattern for each state and is off when idle

#### Scenario: Error state is transient
- **WHEN** the device enters the error state
- **THEN** it returns to idle automatically after a short delay

### Requirement: Ignored protocol events

The device SHALL accept and ignore text events it does not act on (`user_text`, `bot_text`, `tool_call`, `tool_result`) and unknown event types without error.

#### Scenario: Transcript events
- **WHEN** `user_text` or `bot_text` events arrive
- **THEN** the device continues normally and does not log them as errors

#### Scenario: Unknown event
- **WHEN** a text frame with an unrecognised `type` arrives
- **THEN** the device ignores it

### Requirement: Device remains a Home Assistant device

The device SHALL keep its Home Assistant API, OTA updates and logging so it can be adopted, updated and debugged from Home Assistant, but SHALL NOT use the Home Assistant voice pipeline or wake word engine.

#### Scenario: OTA update
- **WHEN** a new configuration is pushed over the air
- **THEN** the device updates without a USB connection

#### Scenario: Home Assistant voice pipeline
- **WHEN** Home Assistant attempts to start a voice assistant pipeline on the device
- **THEN** the device does not participate; only the Friday session exists
