import { LocationNotFoundError } from "./errors.js";
import { DEFAULT_TIME_ZONE } from "@friday/sdk";
import { formatDuration, parseCoordinates, validateTimeArgs } from "./helpers.js";
import type { ResolvedPlace, TomTomClient } from "./types.js";

export interface TravelTimeParams {
  origin: string;
  destination: string;
  /** "" and null count as absent: models sometimes send them for optional arguments. */
  departAt?: string | null;
  arriveAt?: string | null;
}

// A type rather than an interface so it is assignable to the SDK's ToolResult record.
export type TravelTimeResult = {
  mode: "driving";
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  durationSeconds: number;
  durationText: string;
  distanceMeters: number;
  trafficDelaySeconds: number;
  departureTime: string;
  arrivalTime: string;
};

/**
 * Resolves a single input, letting a raw coordinate pair short-circuit the lookup.
 * The parameter name travels with the error so the assistant can say which of the
 * two the user needs to rephrase.
 */
async function resolve(client: TomTomClient, parameter: "origin" | "destination", input: string): Promise<ResolvedPlace> {
  const coordinates = parseCoordinates(input);
  if (coordinates) return coordinates;

  const place = await client.resolvePlace(input);
  if (!place) throw new LocationNotFoundError(parameter, input);
  return place;
}

/** `timeZone` is where offset-less departAt/arriveAt values are read (FRIDAY_TIMEZONE). */
export async function getTravelTime(
  client: TomTomClient,
  params: TravelTimeParams,
  timeZone: string = DEFAULT_TIME_ZONE,
  now: number = Date.now(),
): Promise<TravelTimeResult> {
  // Validate before anything is spent: a bad LLM-generated timestamp should cost
  // zero requests.
  const times = validateTimeArgs({ departAt: params.departAt, arriveAt: params.arriveAt }, timeZone, now);
  if (!times.ok) throw new Error(times.message);

  // Independent lookups, so one round trip rather than two.
  const [origin, destination] = await Promise.all([
    resolve(client, "origin", params.origin),
    resolve(client, "destination", params.destination),
  ]);

  const summary = await client.calculateRoute({
    origin,
    destination,
    ...(times.departAt ? { departAt: times.departAt } : {}),
    ...(times.arriveAt ? { arriveAt: times.arriveAt } : {}),
  });

  return {
    mode: "driving",
    // The resolved names, not the caller's strings — this is what makes a wrong
    // fuzzy match visible instead of hidden inside a confident number.
    origin,
    destination,
    durationSeconds: summary.travelTimeInSeconds,
    durationText: formatDuration(summary.travelTimeInSeconds),
    distanceMeters: summary.lengthInMeters,
    trafficDelaySeconds: summary.trafficDelayInSeconds,
    departureTime: summary.departureTime,
    arrivalTime: summary.arrivalTime,
  };
}
