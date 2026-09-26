import { defineModule, type ToolResult } from "@friday/sdk";
import type { TelemetrySource } from "./telemetry.js";

const lap = (s?: number) => (s === undefined ? undefined : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`);

export function createSimracingModule(source: TelemetrySource) {
  return defineModule({
    manifest: {
      id: "simracing",
      label: "Sim racing",
      description: "Live race information from the sim running on the gaming PC.",
    },
    init(ctx) {
      /** Wrap a handler so every tool answers the same way when there is no session. */
      const withSession = (f: (t: NonNullable<Awaited<ReturnType<TelemetrySource["snapshot"]>>>) => ToolResult) => async (): Promise<ToolResult> => {
        const t = await source.snapshot();
        return t ? f(t) : { error: "not in a session" };
      };

      ctx.defineTool({
        name: "get_race_position",
        description: "Current position in the race and how many cars are in the session.",
        handler: withSession((t) => ({ position: t.position, cars: t.carsInSession, session: t.sessionType })),
      });
      ctx.defineTool({
        name: "get_gap_ahead",
        description: "Time gap in seconds to the car ahead and who is driving it.",
        handler: withSession((t) => (t.gapAheadS === undefined ? { leading: true } : { gap_s: t.gapAheadS, driver: t.driverAhead })),
      });
      ctx.defineTool({
        name: "get_gap_behind",
        description: "Time gap in seconds to the car behind and who is driving it.",
        handler: withSession((t) => (t.gapBehindS === undefined ? { last: true } : { gap_s: t.gapBehindS, driver: t.driverBehind })),
      });
      ctx.defineTool({
        name: "get_fuel_remaining",
        description: "Fuel left in litres, estimated laps of fuel, and whether it is enough to finish.",
        handler: withSession((t) => {
          const laps = t.fuelPerLapLitres > 0 ? Math.floor(t.fuelLitres / t.fuelPerLapLitres) : undefined;
          const remaining = t.totalLaps !== undefined ? t.totalLaps - t.currentLap + 1 : undefined;
          return {
            fuel_litres: t.fuelLitres,
            laps_of_fuel: laps,
            laps_remaining: remaining,
            enough_to_finish: laps !== undefined && remaining !== undefined ? laps >= remaining : undefined,
          };
        }),
      });
      ctx.defineTool({
        name: "get_lap_info",
        description: "Current lap, total laps, last and best lap times, track and car.",
        handler: withSession((t) => ({
          lap: t.currentLap,
          total_laps: t.totalLaps,
          last_lap: lap(t.lastLapS),
          best_lap: lap(t.bestLapS),
          track: t.track,
          car: t.car,
        })),
      });
    },
  });
}
