# Travel Time

## Purpose

Answers "how long does it take to drive from A to B?" with live or predicted traffic, using TomTom, as the `travel` module's `get_travel_time` tool on voice and chat.

## Requirements

### Requirement: Travel module and configuration

An in-process module with id `travel` SHALL register one tool, `get_travel_time`, offered on both the voice and chat channels. The module SHALL declare `TOMTOM_API_KEY` as a required secret config key, so it fails to load, with an error naming the key, when the key is not set. A key changed while the module is loaded SHALL be used from the next call on, without a reload. The key SHALL NOT appear in logs, tool results or error messages.

#### Scenario: Corrected key
- **WHEN** a call fails with a rejected key and the user then saves a new `TOMTOM_API_KEY` in Settings > Configuration
- **THEN** the next call uses the new key without reloading the module

#### Scenario: Key not configured
- **WHEN** the module loads without `TOMTOM_API_KEY`
- **THEN** the module fails with an error naming `TOMTOM_API_KEY` and registers no tools

#### Scenario: Key configured
- **WHEN** the module loads with `TOMTOM_API_KEY` set
- **THEN** `get_travel_time` is available on voice and chat

#### Scenario: Upstream failure does not leak the key
- **WHEN** a TomTom request fails for any reason
- **THEN** neither the log line nor the tool's error contains the API key or the request URL

### Requirement: Tool parameters and result

`get_travel_time` SHALL take a required `origin` and `destination` (a place name, address, point of interest, or a `lat,lon` pair) and an optional `departAt` or `arriveAt` timestamp. It SHALL return car travel only, as: `mode` (`driving`), `origin` and `destination` as resolved places (`name`, `lat`, `lon`), `durationSeconds`, `durationText`, `distanceMeters`, `trafficDelaySeconds` (0 when TomTom reports none), `departureTime` and `arrivalTime`. The resolved place names SHALL be TomTom's (point-of-interest name, else the free-form address), not the caller's input, so a wrong match is visible.

#### Scenario: Journey right now
- **WHEN** called with `origin: "Amsterdam Centraal"` and `destination: "Schiphol"` and no times
- **THEN** the result has `mode: "driving"`, the resolved names, duration, distance, traffic delay, and departure and arrival times, routed on current traffic

#### Scenario: Point of interest versus address
- **WHEN** the top geocoding match is a point of interest
- **THEN** its POI name is the resolved `name`; for an address match the free-form address is used

### Requirement: Speech-friendly duration

`durationText` SHALL round the duration to whole minutes and render it as `less than a minute` (under 30 seconds), `<m> min` under an hour, `1 hour` / `<h> hours` on the hour, or `<h> hour(s) <m> min` otherwise.

#### Scenario: Under an hour
- **WHEN** the route takes 1500 seconds
- **THEN** `durationText` is `25 min`

#### Scenario: Hours and minutes
- **WHEN** the route takes 4340 seconds
- **THEN** `durationText` is `1 hour 12 min`

#### Scenario: Whole hours
- **WHEN** the route takes 7200 seconds
- **THEN** `durationText` is `2 hours`

### Requirement: Location resolution

A `lat,lon` input (optional spaces, latitude within ±90 and longitude within ±180) SHALL be used directly without a geocoding request, with the pair as its name. Any other input SHALL be geocoded with TomTom's top match. Origin and destination SHALL be resolved concurrently. Geocoding matches SHALL be cached for 24 hours and "no match" outcomes for 10 minutes, per normalized query (trimmed, lowercased, whitespace collapsed), bounded in size with the least recently used entry evicted first. A result without numeric coordinates SHALL count as no match. Route results SHALL NOT be cached.

#### Scenario: Coordinates skip geocoding
- **WHEN** `origin` is `52.379, 4.899`
- **THEN** no geocoding request is made for it and its resolved name is `52.379,4.899`

#### Scenario: Out-of-range coordinates are geocoded
- **WHEN** `origin` is `95,4.9`
- **THEN** it is treated as free text and geocoded

#### Scenario: Repeated query is cached
- **WHEN** `Schiphol` and later ` schiphol ` are resolved within 24 hours
- **THEN** only one geocoding request is made

#### Scenario: A miss is retried after 10 minutes
- **WHEN** `Utrecht Centraal` matched nothing and is asked again 11 minutes later
- **THEN** TomTom is queried again

#### Scenario: Frequently asked place survives eviction
- **WHEN** the cache is full and `home` was hit more recently than any other entry
- **THEN** a new lookup evicts the least recently used entry, not `home`

#### Scenario: Location not found
- **WHEN** geocoding `destination: "Nowhereville"` returns no match
- **THEN** the tool returns an error naming the `destination` parameter and the query, and asking for a more specific name or an address, and no route request is made

### Requirement: Departure and arrival times

`departAt` and `arriveAt` SHALL be validated before any TomTom request is made. An empty, blank or null value SHALL count as absent. Giving both SHALL be an error. A value that does not parse as a timestamp SHALL be an error naming the parameter. A `departAt` in the past SHALL be an error suggesting to omit it for a journey right now; an `arriveAt` in the past SHALL be an error too. A timestamp SHALL be an ISO 8601 date-time (`YYYY-MM-DDTHH:mm[:ss[.fff]]`, `T` or a space) with an optional RFC 3339 offset (`Z` or `±HH:MM`), and a date that exists; anything else (RFC 2822, `+0200`, 30 February) is not a valid timestamp. It SHALL be sent to TomTom as `YYYY-MM-DDTHH:mm:ss` plus its offset: the caller's offset unchanged when it has one, otherwise read as local time in `FRIDAY_TIMEZONE` (default `Europe/Amsterdam`, also used when the zone is invalid) with that zone's offset at that moment. When a time is given, TomTom SHALL route on predicted traffic for that time; `arriveAt` returns the latest departure that still arrives on time.

#### Scenario: Both times given
- **WHEN** called with both `departAt` and `arriveAt`
- **THEN** the tool returns an error saying to give only one, and no request is made

#### Scenario: Past departure
- **WHEN** `departAt` is earlier than now
- **THEN** the tool returns an error that `departAt` is in the past, and no request is made

#### Scenario: Past arrival
- **WHEN** `arriveAt` is earlier than now
- **THEN** the tool returns an error that `arriveAt` is in the past, and no request is made

#### Scenario: Empty optional time
- **WHEN** called with `departAt: ""` and a future `arriveAt`
- **THEN** `departAt` is ignored and the route is planned for the arrival time

#### Scenario: Offset in a non-RFC 3339 form
- **WHEN** `departAt` is `2026-10-01T08:00+0200` or `Thu, 01 Oct 2026 08:00:00 +0200`
- **THEN** the tool returns an error that `departAt` is not a valid timestamp, and no request is made

#### Scenario: Unparseable time
- **WHEN** `arriveAt` is `tomorrow morning`
- **THEN** the tool returns an error that `arriveAt` is not a valid timestamp, and no request is made

#### Scenario: Local time without offset
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` and `departAt` is `2026-10-01T08:00:00`
- **THEN** TomTom receives `departAt=2026-10-01T08:00:00+02:00`

#### Scenario: Local time across a DST change
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` and `arriveAt` is `2026-10-25T12:00`
- **THEN** TomTom receives `arriveAt=2026-10-25T12:00:00+01:00`

#### Scenario: Offset-less time that is not ISO 8601
- **WHEN** `departAt` is `Aug 9 2026 08:00`
- **THEN** the tool returns an error that `departAt` is not a valid timestamp, and no request is made

#### Scenario: Time with offset
- **WHEN** `arriveAt` is `2026-10-01T09:00:00Z`
- **THEN** TomTom receives `arriveAt=2026-10-01T09:00:00Z` unchanged

### Requirement: Error reporting

Failures SHALL be reported as tool errors that say which request failed (`geocode` or `route`):

- HTTP 401 or 403: a credential error that includes TomTom's own message and explains that either the key is wrong or it lacks the product entitlement for that endpoint.
- A route response reporting `NO_ROUTE_FOUND`, or a successful response with no route: an error saying no drivable route was found between the two resolved names.
- Any other non-OK status, a network failure, a request that times out, a body that is not JSON, or a route summary without a numeric travel time or length: an upstream error with the status (when there is one) and TomTom's detail message or the cause.

Every TomTom request SHALL time out rather than hang.

#### Scenario: Key lacks entitlement
- **WHEN** TomTom answers the route request with 403 and `You are not allowed to access this endpoint`
- **THEN** the error names the `route` request, HTTP 403, includes that message, and mentions the entitlement as a possible cause

#### Scenario: No route
- **WHEN** TomTom answers the route request with a 400 whose body contains `NO_ROUTE_FOUND`
- **THEN** the error says no drivable route was found between the resolved origin and destination names

#### Scenario: Server error
- **WHEN** TomTom answers the geocode request with 503
- **THEN** the error names the `geocode` request and HTTP 503

#### Scenario: Malformed success
- **WHEN** TomTom answers with 200 and an HTML page, or a route summary without `travelTimeInSeconds`
- **THEN** the error names the request and says the response could not be used, instead of a parse error or a `NaN` duration

#### Scenario: Network failure
- **WHEN** the route request cannot be sent or times out
- **THEN** the error names the `route` request and the cause, without a status
