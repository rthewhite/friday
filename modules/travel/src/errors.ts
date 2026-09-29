/** Which upstream call failed. Carried on errors so a single tool call is enough to diagnose. */
export type UpstreamRequest = 'geocode' | 'route';

/**
 * The API key was rejected. Kept distinct from a routing failure so a missing or
 * wrong TOMTOM_API_KEY does not read as "no route found".
 *
 * Carries TomTom's own wording, because the two causes need different fixes and
 * only the upstream message tells them apart: a *valid* key that lacks the
 * product entitlement for this endpoint answers "you are not allowed to access
 * this endpoint", which is not a reason to go looking at the stored secret.
 */
export class CredentialRejectedError extends Error {
  constructor(
    readonly request: UpstreamRequest,
    readonly status: number,
    detail = '',
  ) {
    super(
      `TomTom rejected the credential on the ${request} request (HTTP ${status})` +
        (detail ? `: ${detail}` : '.') +
        ' Either TOMTOM_API_KEY is wrong, or the key lacks the product entitlement' +
        ' for this endpoint (Routing, Places Search and Geocoding are enabled separately).',
    );
    this.name = 'CredentialRejectedError';
  }
}

/** TomTom found no drivable route between the two resolved places. */
export class NoRouteFoundError extends Error {
  constructor(originName: string, destinationName: string) {
    super(`No drivable route was found between "${originName}" and "${destinationName}".`);
    this.name = 'NoRouteFoundError';
  }
}

/** Any other upstream failure — network error, 5xx, malformed response. */
export class UpstreamRequestError extends Error {
  constructor(
    readonly request: UpstreamRequest,
    readonly status: number | undefined,
    detail: string,
  ) {
    super(
      `The TomTom ${request} request failed` +
        (status === undefined ? '' : ` with HTTP ${status}`) +
        (detail ? `: ${detail}` : '.'),
    );
    this.name = 'UpstreamRequestError';
  }
}

/** A supplied origin or destination matched no known location. */
export class LocationNotFoundError extends Error {
  constructor(
    readonly parameter: 'origin' | 'destination',
    readonly query: string,
  ) {
    super(`Could not find a location matching ${parameter} "${query}". Try a more specific name or an address.`);
    this.name = 'LocationNotFoundError';
  }
}
