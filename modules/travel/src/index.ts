/**
 * Driving travel time with live or predicted traffic, via TomTom (ported from the Jarvis travel-time tool).
 *
 * Config (declared in the manifest, read lazily through ctx.config):
 *   TOMTOM_API_KEY   TomTom key with the Routing and Places Search entitlements
 *   FRIDAY_TIMEZONE  zone for departAt/arriveAt given without an offset (default Europe/Amsterdam)
 */
import { defineModule, Type, type ModuleContext } from "@friday/sdk";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "./helpers.js";
import { createTomTomClient } from "./tomtom.js";
import { getTravelTime, type TravelTimeParams } from "./travel-time.js";
import type { TomTomClient } from "./types.js";

export interface TravelOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createTravelModule(opts: TravelOptions = {}) {
  return defineModule({
    manifest: {
      id: "travel",
      label: "Travel",
      description: "Driving travel time between two places with live or predicted traffic, via TomTom.",
      config: [
        { key: "TOMTOM_API_KEY", required: true, secret: true, description: "TomTom API key (Routing and Places Search enabled)" },
        { key: "FRIDAY_TIMEZONE", description: `IANA zone for departure and arrival times given without an offset (default ${DEFAULT_TIME_ZONE})` },
      ],
    },
    init(ctx) {
      defineTravelTools(ctx, opts.fetch);
    },
  });
}

function defineTravelTools(ctx: ModuleContext, fetchImpl: typeof fetch | undefined): void {
  // Kept between calls so the geocode cache survives, but rebuilt when the key
  // changes: saving a corrected key in the portal does not reload the module, and
  // the credential error tells the user to go and fix exactly that.
  let client: { key: string; tomtom: TomTomClient } | undefined;
  function tomtom(): TomTomClient {
    const key = ctx.config.require("TOMTOM_API_KEY");
    if (client?.key !== key) client = { key, tomtom: createTomTomClient(key, { fetchImpl, log: ctx.log }) };
    return client.tomtom;
  }

  let warnedZone: string | undefined;
  function timeZone(): string {
    const configured = ctx.config.get("FRIDAY_TIMEZONE");
    const { zone, valid } = resolveTimeZone(configured);
    if (!valid && warnedZone !== configured) {
      warnedZone = configured;
      ctx.log.warn(`FRIDAY_TIMEZONE ${JSON.stringify(configured)} is not a valid zone; using ${zone}`);
    }
    return zone;
  }

  ctx.defineTool<TravelTimeParams>({
    name: "get_travel_time",
    description:
      "Get the driving travel time between two locations, including live traffic. " +
      'Locations can be place names, addresses, points of interest, or a "lat,lon" pair. ' +
      "Optionally give either departAt or arriveAt (never both) to plan a future journey " +
      "using predicted traffic instead of current conditions. " +
      "This is car travel only — it cannot answer cycling, walking, or public transport times.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        origin: { type: Type.STRING, description: 'Where the journey starts — place name, address, or "lat,lon"' },
        destination: { type: Type.STRING, description: 'Where the journey ends — place name, address, or "lat,lon"' },
        departAt: {
          type: Type.STRING,
          description:
            "Optional departure time (ISO 8601, e.g. 2026-08-09T08:00:00+02:00; without an offset it is local household time). Cannot be combined with arriveAt.",
        },
        arriveAt: {
          type: Type.STRING,
          description:
            "Optional required arrival time (ISO 8601). Returns the latest departure that still makes it. Cannot be combined with departAt.",
        },
      },
      required: ["origin", "destination"],
    },
    handler: ({ origin, destination, departAt, arriveAt }) => getTravelTime(tomtom(), { origin, destination, departAt, arriveAt }, timeZone()),
  });
}

export default createTravelModule();
