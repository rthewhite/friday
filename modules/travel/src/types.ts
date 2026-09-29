/** A location that has been reduced to coordinates and is ready to route with. */
export interface ResolvedPlace {
  /** The name TomTom resolved, or the raw pair when coordinates were given. */
  name: string;
  lat: number;
  lon: number;
}

/** The parts of a TomTom route summary this tool cares about. */
export interface RouteSummary {
  travelTimeInSeconds: number;
  lengthInMeters: number;
  trafficDelayInSeconds: number;
  departureTime: string;
  arrivalTime: string;
}

export interface RouteRequest {
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  departAt?: string;
  arriveAt?: string;
}

export interface TomTomClient {
  /** Resolves a free-text place name, or null when nothing matched. */
  resolvePlace(query: string): Promise<ResolvedPlace | null>;
  calculateRoute(request: RouteRequest): Promise<RouteSummary>;
}
