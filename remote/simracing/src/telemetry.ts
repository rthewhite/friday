/** What the sim tells us about the current session. `null` when no session is running. */
export interface Telemetry {
  /** Overall race position, 1-based. */
  position: number;
  carsInSession: number;
  /** Seconds to the car ahead / behind; undefined when leading / last. */
  gapAheadS?: number;
  gapBehindS?: number;
  driverAhead?: string;
  driverBehind?: string;
  fuelLitres: number;
  /** Average fuel use per lap, litres. */
  fuelPerLapLitres: number;
  currentLap: number;
  totalLaps?: number;
  lastLapS?: number;
  bestLapS?: number;
  sessionType: "practice" | "qualifying" | "race";
  track: string;
  car: string;
}

export interface TelemetrySource {
  snapshot(): Promise<Telemetry | null>;
}

/** Fixed data for development; a real adapter (iRacing SDK, ACC shared memory, ...) replaces this. */
export class MockTelemetrySource implements TelemetrySource {
  constructor(private data: Telemetry | null = MockTelemetrySource.sample()) {}
  async snapshot(): Promise<Telemetry | null> {
    return this.data;
  }
  set(data: Telemetry | null): void {
    this.data = data;
  }
  static sample(): Telemetry {
    return {
      position: 4,
      carsInSession: 20,
      gapAheadS: 1.8,
      gapBehindS: 0.6,
      driverAhead: "M. Verstappen",
      driverBehind: "L. Norris",
      fuelLitres: 31.4,
      fuelPerLapLitres: 2.9,
      currentLap: 12,
      totalLaps: 25,
      lastLapS: 92.412,
      bestLapS: 91.877,
      sessionType: "race",
      track: "Spa-Francorchamps",
      car: "Porsche 992 GT3 R",
    };
  }
}
