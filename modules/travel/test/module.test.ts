import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import type { ModuleLogger } from "@friday/sdk";
import { createTravelModule } from "../src/index.js";

const KEY = "tt-secret-key";
const env = { TOMTOM_API_KEY: KEY, FRIDAY_TIMEZONE: "Europe/Amsterdam" };

const ROUTE = {
  routes: [
    {
      summary: {
        travelTimeInSeconds: 1500,
        lengthInMeters: 17800,
        trafficDelayInSeconds: 120,
        departureTime: "2099-07-01T08:00:00+02:00",
        arrivalTime: "2099-07-01T08:25:00+02:00",
      },
    },
  ],
};

/** Answers places search with a POI named after the query, and routing with ROUTE (or `route` when given). */
function fakeTomTom(calls: string[], route: () => Response = () => Response.json(ROUTE)): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.toString());
    if (url.pathname.startsWith("/maps/orbis/places/search/")) {
      const query = decodeURIComponent(url.pathname.slice("/maps/orbis/places/search/".length).replace(/\.json$/, ""));
      return Response.json({ results: [{ type: "POI", poi: { name: `${query} (POI)` }, position: { lat: 52.3, lon: 4.8 } }] });
    }
    if (url.pathname.startsWith("/maps/orbis/routing/calculateRoute/")) return route();
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

function captureLog(): { log: ModuleLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  return { log: { log: push, warn: push, error: push }, lines };
}

test("the module fails without TOMTOM_API_KEY and names it", async () => {
  await assert.rejects(createTestHost(createTravelModule()), /module travel: missing required config TOMTOM_API_KEY/);
});

test("get_travel_time is offered on voice and chat", async () => {
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom([]) }), { env });
  assert.deepEqual(h.tools, ["get_travel_time"]);
  assert.deepEqual(h.toolsIn("voice"), ["get_travel_time"]);
  assert.deepEqual(h.toolsIn("chat"), ["get_travel_time"]);
});

test("a call geocodes both ends, routes with the key, and returns the spec's result shape", async () => {
  const calls: string[] = [];
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env });

  const r = await h.call("get_travel_time", { origin: "Amsterdam Centraal", destination: "Schiphol" });

  assert.deepEqual(r.result, {
    mode: "driving",
    origin: { name: "Amsterdam Centraal (POI)", lat: 52.3, lon: 4.8 },
    destination: { name: "Schiphol (POI)", lat: 52.3, lon: 4.8 },
    durationSeconds: 1500,
    durationText: "25 min",
    distanceMeters: 17800,
    trafficDelaySeconds: 120,
    departureTime: "2099-07-01T08:00:00+02:00",
    arrivalTime: "2099-07-01T08:25:00+02:00",
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => new URL(c).searchParams.get("key") === KEY));
});

test("a bare local departAt reaches TomTom with the FRIDAY_TIMEZONE offset", async () => {
  const calls: string[] = [];
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env: { ...env, FRIDAY_TIMEZONE: "America/New_York" } });

  await h.call("get_travel_time", { origin: "52.37,4.89", destination: "52.30,4.76", departAt: "2099-07-01T08:00" });

  assert.equal(calls.length, 1, "coordinates need no geocoding");
  assert.equal(new URL(calls[0]).searchParams.get("departAt"), "2099-07-01T08:00:00-04:00");
});

test("an invalid FRIDAY_TIMEZONE falls back to Europe/Amsterdam and warns once", async () => {
  const calls: string[] = [];
  const { log, lines } = captureLog();
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env: { ...env, FRIDAY_TIMEZONE: "Mars/Olympus" }, log });

  await h.call("get_travel_time", { origin: "52.37,4.89", destination: "52.30,4.76", departAt: "2099-07-01T08:00" });
  await h.call("get_travel_time", { origin: "52.37,4.89", destination: "52.30,4.76", departAt: "2099-07-01T09:00" });

  assert.equal(new URL(calls[0]).searchParams.get("departAt"), "2099-07-01T08:00:00+02:00");
  assert.equal(lines.filter((l) => l.includes("Mars/Olympus")).length, 1);
});

test("a rejected key becomes an { error } result that explains it and does not contain the key", async () => {
  const { log, lines } = captureLog();
  const h = await createTestHost(
    createTravelModule({ fetch: fakeTomTom([], () => Response.json({ detailedError: { message: "You are not allowed to access this endpoint" } }, { status: 403 })) }),
    { env, log },
  );

  const r = await h.call("get_travel_time", { origin: "Amsterdam", destination: "Utrecht" });

  const error = (r.result as { error: string }).error;
  assert.match(error, /route request \(HTTP 403\): You are not allowed to access this endpoint/);
  assert.match(error, /entitlement/);
  assert.ok(!error.includes(KEY));
  assert.ok(lines.every((l) => !l.includes(KEY)));
});

test("a key corrected after init is used on the next call, without a reload", async () => {
  const calls: string[] = [];
  const liveEnv: Record<string, string> = { ...env, TOMTOM_API_KEY: "wrong-key" };
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env: liveEnv });

  await h.call("get_travel_time", { origin: "52.37,4.89", destination: "52.30,4.76" });
  liveEnv.TOMTOM_API_KEY = "fixed-key";
  await h.call("get_travel_time", { origin: "52.37,4.89", destination: "52.30,4.76" });

  assert.deepEqual(calls.map((c) => new URL(c).searchParams.get("key")), ["wrong-key", "fixed-key"]);
});

test("the geocode cache survives between calls while the key is unchanged", async () => {
  const calls: string[] = [];
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env });

  await h.call("get_travel_time", { origin: "Home", destination: "52.30,4.76" });
  await h.call("get_travel_time", { origin: "Home", destination: "52.30,4.76" });

  assert.equal(calls.filter((c) => c.includes("/places/search/")).length, 1);
});

test("an empty optional time from the model is ignored", async () => {
  const calls: string[] = [];
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env });

  const r = await h.call("get_travel_time", { origin: "52.37,4.89", destination: "52.30,4.76", departAt: "", arriveAt: "2099-07-01T09:00" });

  assert.equal((r.result as { mode?: string }).mode, "driving");
  assert.equal(new URL(calls[0]).searchParams.get("arriveAt"), "2099-07-01T09:00:00+02:00");
  assert.equal(new URL(calls[0]).searchParams.get("departAt"), null);
});

test("a time validation failure makes no request", async () => {
  const calls: string[] = [];
  const h = await createTestHost(createTravelModule({ fetch: fakeTomTom(calls) }), { env });

  const r = await h.call("get_travel_time", { origin: "Amsterdam", destination: "Utrecht", departAt: "2099-07-01T08:00Z", arriveAt: "2099-07-01T09:00Z" });

  assert.match((r.result as { error: string }).error, /not both/);
  assert.equal(calls.length, 0);
});
