# Spec Delta

## ADDED Requirements

### Requirement: Household time zone helper

`@friday/sdk` SHALL export the household's default zone `Europe/Amsterdam`, a function that resolves a zone name to itself when it is a valid IANA zone and to the default otherwise (reporting whether it was valid, with an unset or blank name counting as valid and resolving to the default), and a function `localDate(at, zone)` that returns the `YYYY-MM-DD` date of an instant in a zone. It SHALL also export a reader built from a module's `ctx.config` and a warning function, which returns the resolved zone of `FRIDAY_TIMEZONE` on every call, so a value saved later is picked up without a reload. The reader SHALL warn once per distinct invalid value, naming the value and the zone used instead, and SHALL warn again when the same invalid value returns after a valid one. The helper SHALL use only the platform's `Intl`, so in-process and remote modules can both use it.

#### Scenario: Valid zone
- **WHEN** `FRIDAY_TIMEZONE` is `Asia/Tokyo`
- **THEN** the reader returns `Asia/Tokyo` and warns nothing

#### Scenario: Unset zone
- **WHEN** `FRIDAY_TIMEZONE` is unset or blank
- **THEN** the reader returns `Europe/Amsterdam` and warns nothing

#### Scenario: Invalid zone warns once
- **WHEN** `FRIDAY_TIMEZONE` is `Mars/Olympus` and the reader is called three times
- **THEN** each call returns `Europe/Amsterdam` and exactly one warning names `Mars/Olympus` and `Europe/Amsterdam`

#### Scenario: Zone changed after init
- **WHEN** `FRIDAY_TIMEZONE` changes from `Europe/Amsterdam` to `America/New_York` between two calls
- **THEN** the second call returns `America/New_York`

#### Scenario: Local date across midnight
- **WHEN** `localDate` is called with `2026-09-28T23:30:00Z` and `Europe/Amsterdam`
- **THEN** it returns `2026-09-29`
