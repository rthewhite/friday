# reSpeaker Client

## Purpose

Firmware behaviour of a Seeed reSpeaker XVF3800 4-mic array with an onboard XIAO ESP32-S3 running as a Friday voice satellite. It covers wake-word sessions, the board's mute and LED ring, the XVF3800 firmware check, capture and playback through the XVF3800, and volume, on the same WebSocket audio protocol and device onboarding as the Voice PE.

## Requirements

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

Where those requirements mention the hardware mute switch, the volume dial or the top button, this capability's mute, volume and session-control requirements apply instead.

#### Scenario: Onboarding
- **WHEN** the device starts for the first time and the wake word is spoken
- **THEN** Friday records a pending attempt with the fingerprint the device logs and shows in Home Assistant, and after it is accepted in the portal the next wake word opens a session

#### Scenario: Conversation
- **WHEN** the wake word is spoken and the user asks a question
- **THEN** the device streams the question, plays Friday's reply through the board's speaker, and goes idle when Friday ends the conversation

#### Scenario: Same server
- **WHEN** the Voice PE and this device are configured with the same Friday url
- **THEN** both connect with their own device ids and keys, and neither configuration needs server changes

### Requirement: Sessions start by wake word only

The device SHALL start a session only on wake word detection, or when an automation in the device configuration calls the start action. The board's Mute button SHALL NOT start or stop a session. Friday ends the session, and the device returns to idle when it does.

#### Scenario: Mute button while idle
- **WHEN** the device is idle and the Mute button is pressed
- **THEN** the device mutes and no session starts

#### Scenario: Friday ends the session
- **WHEN** Friday sends `closed` at the end of a conversation
- **THEN** the remaining speech plays and the device returns to idle, ready for the next wake word

### Requirement: Mute silences the microphones

Pressing the board's Mute button SHALL toggle mute. While muted:
- the microphones SHALL deliver silence to every consumer, the wake word detector included;
- the board's red mute LED SHALL be lit;
- no session SHALL start.

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

#### Scenario: Restart while muted
- **WHEN** the device is muted and then restarts or loses power
- **THEN** it comes back muted

### Requirement: The XVF3800 firmware is checked at boot

At boot the device SHALL read the XVF3800's firmware version and compare it with the one version the configuration supports (1.0.9, I2S master, 48 kHz). If the XVF3800 does not answer, or reports another version, the device SHALL:
- log the reason, including the version found,
- report the problem in a Home Assistant diagnostic sensor,
- not start sessions.

On a supported version the sensor SHALL show the version.

#### Scenario: Supported firmware
- **WHEN** the XVF3800 reports version 1.0.9
- **THEN** the device configures it and works normally, and the diagnostic sensor shows `1.0.9`

#### Scenario: Wrong firmware
- **WHEN** the XVF3800 reports any other version
- **THEN** the log names the version found and the version required, the diagnostic sensor says the firmware is unsupported, and the wake word does not start a session

#### Scenario: XVF3800 not answering
- **WHEN** the XVF3800 does not answer on I2C, for example because it still runs its USB firmware
- **THEN** the log says so and points to the README's flashing instructions, the diagnostic sensor reports it, and no session starts

### Requirement: The XVF3800 is configured at every boot

On every boot with supported firmware, the device SHALL apply its XVF3800 settings: which processed signal goes to each I2S channel, amplifier enabled, LED ring powered, and the stored mute state. The XVF3800 does not persist these. Applying them SHALL be safe when the XVF3800 kept running across an ESP32 restart.

#### Scenario: Power-on
- **WHEN** the board is powered on
- **THEN** after boot the speaker plays, the ring lights for state changes, and the microphone channels carry the configured signals

#### Scenario: ESP32-only restart
- **WHEN** the ESP32 restarts after an OTA update while the XVF3800 keeps running
- **THEN** the settings are applied again and audio and LEDs behave as after a power-on

### Requirement: Capture is 16 kHz echo-cancelled audio

The device SHALL derive the 16 kHz audio that Friday and the wake word detector need from the board's 48 kHz I2S stream, low-pass filtered before decimation:
- passband ripple at most 0.5 dB up to 7 kHz,
- at least 50 dB of attenuation from 8 kHz up.

Friday SHALL receive the XVF3800's echo-cancelled, noise-suppressed signal. The wake word detector SHALL receive the XVF3800's speech-recognition signal.

#### Scenario: Sample rate
- **WHEN** a session streams audio
- **THEN** the server receives 16 kHz mono s16le, and speech sounds at its normal pitch and speed

#### Scenario: Out-of-band content
- **WHEN** the 48 kHz stream contains a 12 kHz tone
- **THEN** the 16 kHz output contains it attenuated by at least 50 dB rather than folded back to 4 kHz

#### Scenario: Barge-in
- **WHEN** Friday speaks through the board's speaker and the user talks over it
- **THEN** Friday's own voice does not trigger an interruption and the user's voice does

### Requirement: Playback uses the board's speaker and a settable volume

The device SHALL play all audio through the board's speaker output, so that the XVF3800 receives it as its echo reference. This covers Friday's replies and the chime. Volume SHALL be a Home Assistant number entity from 0 to 100 %. The volume SHALL apply to all playback and SHALL be restored after a restart.

#### Scenario: Change volume
- **WHEN** the volume is set to 40 % in Home Assistant
- **THEN** the next chime and reply play at that level

#### Scenario: Restart
- **WHEN** the device restarts
- **THEN** it plays at the volume last set

### Requirement: The LED ring shows session state

The device SHALL show a distinct LED ring pattern for each of these states:
- connecting,
- listening,
- speaking,
- pending,
- error,
- no Wi-Fi.

The ring SHALL be off when idle. Its colour and brightness SHALL be settable from Home Assistant as a light.

#### Scenario: Session patterns
- **WHEN** the device goes through connecting, listening and speaking
- **THEN** the ring shows a different pattern for each, and turns off when the device is idle again

#### Scenario: Pending approval
- **WHEN** Friday answers `4403` because the device is not accepted yet
- **THEN** the ring shows the pending pattern briefly and then turns off

#### Scenario: Colour from Home Assistant
- **WHEN** the ring's colour is changed in Home Assistant
- **THEN** the listening and speaking patterns use that colour
