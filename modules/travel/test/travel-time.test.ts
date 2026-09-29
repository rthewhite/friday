import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTravelTime } from "../src/travel-time.js";
import type { ResolvedPlace, RouteRequest, RouteSummary, TomTomClient } from "../src/types.js";

const SUMMARY: RouteSummary = {
  travelTimeInSeconds: 4340,
  lengthInMeters: 45000,
  trafficDelayInSeconds: 300,
  departureTime: "2026-08-08T12:00:00+02:00",
  arrivalTime: "2026-08-08T13:12:20+02:00",
};

/** A client that records what it was asked; override either method to change the answer. */
function stubClient(overrides: Partial<TomTomClient> = {}) {
  const resolved: string[] = [];
  const routed: RouteRequest[] = [];
  const resolvePlace = overrides.resolvePlace ?? (async (query: string): Promise<ResolvedPlace | null> => ({ name: `Resolved ${query}`, lat: 52, lon: 5 }));
  const calculateRoute = overrides.calculateRoute ?? (async (): Promise<RouteSummary> => SUMMARY);
  const client: TomTomClient = {
    resolvePlace: (q) => (resolved.push(q), resolvePlace(q)),
    calculateRoute: (r) => (routed.push(r), calculateRoute(r)),
  };
  return { client, resolved, routed };
}

const FUTURE = "2099-01-01T08:00:00Z";

describe("getTravelTime", () => {
  it("returns the resolved names, not the caller strings", async () => {
    const { client } = stubClient();

    const result = await getTravelTime(client, { origin: "ams", destination: "utr" });

    assert.equal(result.origin.name, "Resolved ams");
    assert.equal(result.destination.name, "Resolved utr");
  });

  it("shapes the full result", async () => {
    const { client } = stubClient();

    assert.deepEqual(await getTravelTime(client, { origin: "ams", destination: "utr" }), {
      mode: "driving",
      origin: { name: "Resolved ams", lat: 52, lon: 5 },
      destination: { name: "Resolved utr", lat: 52, lon: 5 },
      durationSeconds: 4340,
      durationText: "1 hour 12 min",
      distanceMeters: 45000,
      trafficDelaySeconds: 300,
      departureTime: "2026-08-08T12:00:00+02:00",
      arrivalTime: "2026-08-08T13:12:20+02:00",
    });
  });

  it("resolves origin and destination concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = stubClient({
      resolvePlace: async (query: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { name: `Resolved ${query}`, lat: 52, lon: 5 };
      },
    });

    await getTravelTime(client, { origin: "ams", destination: "utr" });

    assert.equal(maxInFlight, 2);
  });

  it("bypasses resolution for a coordinate pair", async () => {
    const { client, resolved } = stubClient();

    const result = await getTravelTime(client, { origin: "52.379,4.899", destination: "utr" });

    assert.deepEqual(resolved, ["utr"]);
    assert.deepEqual(result.origin, { name: "52.379,4.899", lat: 52.379, lon: 4.899 });
  });

  it("geocodes an out-of-range coordinate pair as free text", async () => {
    const { client, resolved } = stubClient();

    const result = await getTravelTime(client, { origin: "95,4.9", destination: "utr" });

    assert.deepEqual(resolved.sort(), ["95,4.9", "utr"]);
    assert.equal(result.origin.name, "Resolved 95,4.9");
  });

  it("makes no upstream call at all when both times are given", async () => {
    const { client, resolved, routed } = stubClient();

    await assert.rejects(getTravelTime(client, { origin: "ams", destination: "utr", departAt: FUTURE, arriveAt: FUTURE }), /not both/);
    assert.equal(resolved.length, 0);
    assert.equal(routed.length, 0);
  });

  it("makes no upstream call when a timestamp is unparseable", async () => {
    const { client, resolved, routed } = stubClient();

    await assert.rejects(getTravelTime(client, { origin: "ams", destination: "utr", departAt: "tomorrow morning" }), /departAt is not a valid timestamp/);
    assert.equal(resolved.length, 0);
    assert.equal(routed.length, 0);
  });

  it("makes no upstream call when the departure is in the past", async () => {
    const { client, resolved, routed } = stubClient();

    await assert.rejects(getTravelTime(client, { origin: "ams", destination: "utr", departAt: "2020-01-01T08:00:00Z" }), /in the past/);
    assert.equal(resolved.length, 0);
    assert.equal(routed.length, 0);
  });

  it("forwards a future departAt to the route request", async () => {
    const { client, routed } = stubClient();

    await getTravelTime(client, { origin: "ams", destination: "utr", departAt: FUTURE });

    assert.equal(routed[0].departAt, FUTURE);
    assert.ok(!("arriveAt" in routed[0]));
  });

  it("forwards an arriveAt to the route request", async () => {
    const { client, routed } = stubClient();

    await getTravelTime(client, { origin: "ams", destination: "utr", arriveAt: FUTURE });

    assert.equal(routed[0].arriveAt, FUTURE);
    assert.ok(!("departAt" in routed[0]));
  });

  it("forwards an offset-less time with the given zone's offset", async () => {
    const { client, routed } = stubClient();

    await getTravelTime(client, { origin: "ams", destination: "utr", departAt: "2099-07-01T08:00" }, "Europe/Amsterdam");

    assert.equal(routed[0].departAt, "2099-07-01T08:00:00+02:00");
  });

  it("names the failing parameter and echoes the string when a location does not resolve", async () => {
    const { client, routed } = stubClient({
      resolvePlace: async (query: string) => (query === "Nowherecity Qxz" ? null : { name: query, lat: 52, lon: 5 }),
    });

    await assert.rejects(getTravelTime(client, { origin: "ams", destination: "Nowherecity Qxz" }), /destination "Nowherecity Qxz"/);
    assert.equal(routed.length, 0);
  });

  it("names origin when it is the origin that fails", async () => {
    const { client } = stubClient({ resolvePlace: async () => null });

    await assert.rejects(getTravelTime(client, { origin: "Nowherecity Qxz", destination: "utr" }), /origin "Nowherecity Qxz"/);
  });

  it("returns a near-zero result rather than an error when origin and destination are the same", async () => {
    const { client } = stubClient({
      calculateRoute: async () => ({
        travelTimeInSeconds: 0,
        lengthInMeters: 0,
        trafficDelayInSeconds: 0,
        departureTime: "2026-08-08T12:00:00+02:00",
        arrivalTime: "2026-08-08T12:00:00+02:00",
      }),
    });

    const result = await getTravelTime(client, { origin: "ams", destination: "ams" });

    assert.equal(result.durationSeconds, 0);
    assert.equal(result.durationText, "less than a minute");
    assert.equal(result.distanceMeters, 0);
  });

  it("propagates a client failure unchanged", async () => {
    const { client } = stubClient({
      calculateRoute: async () => {
        throw new Error('No drivable route was found between "A" and "B".');
      },
    });

    await assert.rejects(getTravelTime(client, { origin: "ams", destination: "utr" }), /No drivable route/);
  });
});
