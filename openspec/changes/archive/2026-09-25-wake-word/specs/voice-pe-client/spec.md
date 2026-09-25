# Spec Delta

## ADDED Requirements

### Requirement: Wake word starts a session

The device SHALL detect the configured wake word on the device itself and, when detected while idle and not muted, SHALL start a Friday session exactly as a single button click does. Audio SHALL NOT be sent to any server before the wake word is detected.

#### Scenario: Wake word while idle
- **WHEN** the device is idle, not muted, and the wake word is spoken
- **THEN** the device connects to the Friday server and begins streaming microphone audio

#### Scenario: Wake word while muted
- **WHEN** the software mute is on and the wake word is spoken
- **THEN** no session starts and the device stays idle

#### Scenario: Hardware mute
- **WHEN** the hardware mute switch is on
- **THEN** the wake word cannot be detected because the microphones are cut

#### Scenario: Detection is local
- **WHEN** the device is idle and people are talking nearby without saying the wake word
- **THEN** no network connection to the Friday server is opened

### Requirement: Wake word is ignored during a session

While the device is connecting, listening, speaking, or showing an error, the wake word SHALL NOT start, restart, or otherwise affect the session.

#### Scenario: Wake word during a reply
- **WHEN** Friday is speaking and the wake word is spoken
- **THEN** the session continues unchanged

#### Scenario: Wake word while connecting
- **WHEN** the device is connecting and the wake word is spoken again
- **THEN** only one session is started

#### Scenario: Wake word after the session ends
- **WHEN** a session has ended and the device is idle again
- **THEN** the wake word starts a new session

### Requirement: Chime confirms wake word detection

On wake word detection the device SHALL play a short chime through the speaker before or while the session connects, at the current device volume, so the user knows they were heard without looking at the device.

#### Scenario: Chime on detection
- **WHEN** the wake word is detected while idle
- **THEN** a chime of well under a second plays and the device proceeds to connect

#### Scenario: Chime does not delay speech
- **WHEN** Friday's first reply audio arrives while the chime is still playing
- **THEN** the chime finishes and the reply plays immediately after, in order

#### Scenario: Button press has no chime
- **WHEN** a session is started with the button
- **THEN** no chime plays

### Requirement: Wake word model is configurable

The wake word model SHALL be selected in the device configuration by reference to a model file, pinned to an immutable version, so the phrase can be changed or the model upgraded by editing configuration only.

#### Scenario: Swap model
- **WHEN** the model reference in the configuration is changed and the device is reflashed
- **THEN** the new phrase starts sessions and the old one does not

#### Scenario: Reproducible build
- **WHEN** the firmware is rebuilt from the same configuration at a later date
- **THEN** the same model version is compiled in

## MODIFIED Requirements

### Requirement: Microphone audio is streamed while a session is active

While a session is active the device SHALL stream one channel of echo-cancelled microphone audio as 16 kHz mono signed 16-bit little-endian PCM in binary WebSocket frames. Capture SHALL run in both the listening and speaking states so the user can interrupt Friday. For a short, configurable period at the start of each reply (default 1.5 s) the device SHALL send silence instead of microphone audio, because the echo canceller has not yet converged and Friday's own voice would otherwise be taken as an interruption. The device SHALL read the echo-cancelled microphone channel without automatic gain control.

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

#### Scenario: Start of a reply
- **WHEN** Friday starts speaking
- **THEN** for the barge-in delay the server receives silence, and afterwards live microphone audio again

#### Scenario: Friday's own voice
- **WHEN** Friday speaks a long reply and nobody else talks
- **THEN** the reply plays to the end without the server reporting an interruption
