/**
 * Driving travel time with live or predicted traffic, via TomTom (ported from the Jarvis travel-time tool).
 *
 * Config (declared in the manifest, read lazily through ctx.config):
 *   TOMTOM_API_KEY   TomTom key with the Routing and Places Search entitlements
 *   FRIDAY_TIMEZONE  zone for departAt/arriveAt given without an offset (default Europe/Amsterdam)
 */
import { defineModule } from "@friday/sdk";

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
      ],
    },
    init() {},
  });
}

export default createTravelModule();
