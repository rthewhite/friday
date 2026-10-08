# Spec Delta

## ADDED Requirements

### Requirement: The device keeps a control connection to Friday

Once Wi-Fi is up, the device SHALL keep a control connection open to `<configured base url>/ws/device?device=<device id>` (as specified in `audio-transport`), using the same scheme, certificate checks, device id and `Authorization` header as its sessions. The control connection SHALL stay open while the device is idle and during sessions. When it closes or cannot be opened, the device SHALL reconnect, waiting 1 second after the first failure and doubling the wait after each further failure up to 60 seconds, and resetting the wait once a connection stays open. After a close with `4401`, `4403` or `4409`, it SHALL wait 60 seconds before reconnecting. The control connection SHALL NOT change the session state or the LEDs. The device SHALL expose whether it is open as a Home Assistant binary sensor.

#### Scenario: Boot
- **WHEN** the device starts and joins Wi-Fi
- **THEN** it opens its control connection, and the portal lists it as online

#### Scenario: Server restart
- **WHEN** Friday restarts and the control connection drops
- **THEN** the device reconnects within a minute of Friday being back, without a reboot and without LED changes

#### Scenario: Not yet accepted
- **WHEN** the device is not accepted yet and the server closes the control connection with `4403`
- **THEN** the device retries every 60 seconds, so its pending attempt stays fresh in the portal, and its LEDs stay off

### Requirement: The device answers a ring with an alert session

When the control connection receives `ring` for an alert, the device SHALL:
- when idle and not muted: start a session at `<configured base url>/ws/audio?device=<device id>&alert=<alert id>` as a button click does, without the wake word chime;
- when muted (hardware switch or software mute): ring the alert with its local tone (as specified in "The device rings locally when Friday can't be heard");
- when ringing locally: add the alert to the alerts it rings;
- in any other state: ignore the ring.

When the alert session is closed with `4410` before any audio arrived, the device SHALL return to idle without showing the error state. When it cannot be opened, or is closed with any other code before any audio arrived, the device SHALL ring the alert with its local tone. When the top button ends an alert session, the device SHALL send `acknowledged` for its alert over the control connection.

#### Scenario: Timer goes off
- **WHEN** the device is idle and receives `ring`
- **THEN** it connects with the alert parameter, plays the alert tone and Friday's announcement, and listens for the answer

#### Scenario: Ring during a conversation
- **WHEN** the device receives `ring` while a session is active
- **THEN** the session continues unchanged

#### Scenario: Alert already gone
- **WHEN** the alert session is closed with `4410`
- **THEN** the device returns to idle quietly

#### Scenario: Gemini down
- **WHEN** the alert session is closed with `1011` before any audio arrived
- **THEN** the device rings the alert with its local tone

#### Scenario: Muted
- **WHEN** the hardware mute switch is on and the device receives `ring`
- **THEN** it rings the alert with its local tone instead of starting a session

#### Scenario: Button during the announcement
- **WHEN** Friday is announcing an alert and the user single-clicks the button
- **THEN** the session ends, and the device sends `acknowledged` for the alert

### Requirement: The device rings locally when Friday can't be heard

When it rings alerts with its local tone, the device SHALL:
- enter the `ringing` state and send `ringing_locally` for each alert, and again whenever Friday rings an alert it already rings;
- repeat a tone built from its chime, at the current device volume, through the same output path as other device audio;
- on a single click of the top button: stop, send `acknowledged` for each alert, and return to idle;
- on `stop` from the control connection: stop ringing that alert, and return to idle when no alert is left;
- after a configurable limit (default 5 minutes) without a button click: stop, send `unanswered` for each alert, and return to idle.

The wake word SHALL NOT start a session while the device rings. A report made while the control connection is down SHALL be kept (the latest few) and sent, in order, as soon as it is open again, before the device acts on messages from Friday.

#### Scenario: Stopped by the button
- **WHEN** the device rings locally and the button is single-clicked
- **THEN** the tone stops, Friday is told the alert was acknowledged, and the device is idle

#### Scenario: Nobody home
- **WHEN** the device rings locally for 5 minutes without a click
- **THEN** the tone stops, Friday is told the alert went unanswered, and the device is idle

#### Scenario: Cancelled elsewhere
- **WHEN** the device rings an alert locally and the user cancels it in the portal
- **THEN** the device receives `stop` and the tone stops

## MODIFIED Requirements

### Requirement: Session is controlled by the top button

The device SHALL start a Friday session when the top button is single-clicked while idle, and SHALL end the current session when the top button is single-clicked while connecting, listening or speaking. A single click while the device rings locally SHALL stop the ringing (as specified in "The device rings locally when Friday can't be heard"). Other button gestures (long press, double or triple click) SHALL NOT affect the Friday session or the ringing.

#### Scenario: Start from idle
- **WHEN** the device is idle and the button is single-clicked
- **THEN** the device connects to the Friday server and begins streaming microphone audio

#### Scenario: Stop while listening or speaking
- **WHEN** a session is active and the button is single-clicked
- **THEN** the microphone stops, the connection is closed, and the device returns to idle

#### Scenario: Click while connecting
- **WHEN** the device is still connecting and the button is single-clicked
- **THEN** the connection attempt is abandoned and the device returns to idle

#### Scenario: Click while ringing
- **WHEN** the device rings locally and the button is single-clicked
- **THEN** the ringing stops and no session starts

#### Scenario: Other gestures
- **WHEN** the button is long-pressed or multi-clicked
- **THEN** the Friday session state is unchanged

### Requirement: Session state is exposed to the device configuration

The device SHALL expose its session state (idle, connecting, listening, speaking, ringing, pending, error) to the ESPHome configuration through a trigger so LED behaviour can be defined in YAML, and SHALL expose start, stop and toggle actions.

#### Scenario: State change
- **WHEN** the session state changes
- **THEN** the configured on-state automation runs with the new state

#### Scenario: LED feedback
- **WHEN** the device is connecting, listening, speaking, ringing, pending, or in error
- **THEN** the LED ring shows a distinct pattern for each state and is off when idle

#### Scenario: Error state is transient
- **WHEN** the device enters the error state
- **THEN** it returns to idle automatically after a short delay

#### Scenario: Pending state is transient
- **WHEN** the device enters the pending state
- **THEN** it returns to idle automatically after a short delay
