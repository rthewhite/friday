# Spec Delta

## MODIFIED Requirements

### Requirement: Session, audio and identity behave as on the Voice PE

The device SHALL meet these `voice-pe-client` requirements as written there, with "the device" meaning this satellite:
- Session connects to a configured Friday server
- Microphone audio is streamed while a session is active
- Server audio is played through the speaker
- Interruption flushes playback
- Server-initiated close drains playback
- Session state is exposed to the device configuration
- Ignored protocol events
- Device remains a Home Assistant device
- Wake word starts a session
- Wake word is ignored during a session
- Chime confirms wake word detection
- Wake word model is configurable
- The device generates and keeps its own key
- The device shows its key fingerprint
- The device keeps a control connection to Friday
- The device answers a ring with an alert session
- The device rings locally when Friday can't be heard

Where those requirements mention the hardware mute switch, the volume dial or the top button, this capability's mute, volume and session-control requirements apply instead. In particular, the board's Mute button takes the top button's place for stopping a local ring, and the device has no button that ends an alert session.

#### Scenario: Onboarding
- **WHEN** the device starts for the first time and joins Wi-Fi
- **THEN** Friday records a pending attempt with the fingerprint the device logs and shows in Home Assistant, and after it is accepted in the portal the device comes online and the next wake word opens a session

#### Scenario: Conversation
- **WHEN** the wake word is spoken and the user asks a question
- **THEN** the device streams the question, plays Friday's reply through the board's speaker, and goes idle when Friday ends the conversation

#### Scenario: Same server
- **WHEN** the Voice PE and this device are configured with the same Friday url
- **THEN** both connect with their own device ids and keys, and neither configuration needs server changes

#### Scenario: Timer in the kitchen
- **WHEN** a timer set on this device falls due
- **THEN** the device plays the alert tone and Friday's announcement, and the user can answer by voice

### Requirement: Sessions start by wake word only

The device SHALL start a session only on wake word detection, on a `ring` from Friday (as specified in "The device answers a ring with an alert session"), or when an automation in the device configuration calls the start action. The board's Mute button SHALL NOT start or stop a session. Friday ends the session, and the device returns to idle when it does.

#### Scenario: Mute button while idle
- **WHEN** the device is idle and the Mute button is pressed
- **THEN** the device mutes and no session starts

#### Scenario: Friday ends the session
- **WHEN** Friday sends `closed` at the end of a conversation
- **THEN** the remaining speech plays and the device returns to idle, ready for the next wake word

#### Scenario: Friday rings
- **WHEN** the device is idle and not muted and Friday sends `ring`
- **THEN** the device opens an alert session without the wake word

### Requirement: Mute silences the microphones

Pressing the board's Mute button SHALL toggle mute, except while the device rings locally, when it SHALL stop the ringing (as specified in `voice-pe-client` "The device rings locally when Friday can't be heard") and leave mute unchanged. While muted:
- the microphones SHALL deliver silence to every consumer, the wake word detector included;
- the board's red mute LED SHALL be lit;
- no session SHALL start, and a `ring` from Friday SHALL be rung with the local tone.

The device SHALL expose mute as a Home Assistant switch that reflects the button's state and, when switched, mutes or unmutes the same way. The mute state SHALL be restored after the ESP32 restarts and after a power cut.

#### Scenario: Mute while idle
- **WHEN** the Mute button is pressed while the device is idle
- **THEN** the red mute LED lights, the Home Assistant switch turns on, and the wake word no longer starts a session

#### Scenario: Unmute
- **WHEN** the device is muted and the Mute button is pressed
- **THEN** the red mute LED goes out, the switch turns off, and the wake word works again

#### Scenario: Mute from Home Assistant
- **WHEN** the Mute switch is turned on in Home Assistant
- **THEN** the device mutes exactly as if the button had been pressed, and the red mute LED lights

#### Scenario: Mute during a session
- **WHEN** the device is muted while a session is active
- **THEN** the server receives silence for as long as the device is muted, and Friday's playback continues

#### Scenario: Start requested while muted
- **WHEN** the device is muted and a start is requested by an automation
- **THEN** the device does not start a session and shows the error state

#### Scenario: Ring while muted
- **WHEN** the device is muted and Friday sends `ring`
- **THEN** the device rings the alert with its local tone and stays muted

#### Scenario: Stop a local ring
- **WHEN** the device rings locally and the Mute button is pressed
- **THEN** the ringing stops, Friday is told the alert was acknowledged, and the mute state is unchanged

#### Scenario: Restart while muted
- **WHEN** the device is muted and then restarts or loses power
- **THEN** it comes back muted

### Requirement: The LED ring shows session state

The device SHALL show a distinct LED ring pattern for each of these states:
- connecting,
- listening,
- speaking,
- ringing,
- pending,
- error,
- no Wi-Fi.

The ring SHALL be off when idle. Its colour and brightness SHALL be settable from Home Assistant as a light.

#### Scenario: Session patterns
- **WHEN** the device goes through connecting, listening and speaking
- **THEN** the ring shows a different pattern for each, and turns off when the device is idle again

#### Scenario: Ringing
- **WHEN** the device rings an alert with its local tone
- **THEN** the ring shows the ringing pattern until the ringing stops

#### Scenario: Pending approval
- **WHEN** Friday answers `4403` because the device is not accepted yet
- **THEN** the ring shows the pending pattern briefly and then turns off

#### Scenario: Colour from Home Assistant
- **WHEN** the ring's colour is changed in Home Assistant
- **THEN** the listening and speaking patterns use that colour
