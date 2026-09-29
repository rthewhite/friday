import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModuleLogger } from "@friday/sdk";
import { CredentialRejectedError, NoRouteFoundError, UpstreamRequestError } from "../src/errors.js";
import { createTomTomClient, type TomTomClientOptions } from "../src/tomtom.js";
import type { ResolvedPlace } from "../src/types.js";

const KEY = "secret-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

/** A fake fetch that records every URL and answers with `respond` (a fresh Response per call). */
function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function captureLog(): { log: ModuleLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  return { log: { log: push, warn: push, error: push }, lines };
}

function client(respond: (url: string, init?: RequestInit) => Response | Promise<Response>, options: TomTomClientOptions = {}) {
  const { fetchImpl, calls } = fakeFetch(respond);
  const { log, lines } = captureLog();
  return { c: createTomTomClient(KEY, { fetchImpl, log, ...options }), calls, lines };
}

const AMSTERDAM: ResolvedPlace = { name: "Amsterdam", lat: 52.379, lon: 4.899 };
const UTRECHT: ResolvedPlace = { name: "Utrecht", lat: 52.09, lon: 5.121 };

const GEO_BODY = { results: [{ type: "Geography", address: { freeformAddress: "Amsterdam" }, position: { lat: 52.379, lon: 4.899 } }] };

const ROUTE_BODY = {
  routes: [
    {
      summary: {
        travelTimeInSeconds: 2400,
        lengthInMeters: 45000,
        trafficDelayInSeconds: 300,
        departureTime: "2026-08-08T12:00:00+02:00",
        arrivalTime: "2026-08-08T12:40:00+02:00",
      },
    },
  ],
};

describe("resolvePlace", () => {
  it("calls the places endpoint with apiVersion 1", async () => {
    const { c, calls } = client(() => jsonResponse(GEO_BODY));

    await c.resolvePlace("Amsterdam");

    assert.ok(calls[0].includes("/maps/orbis/places/search/Amsterdam.json"));
    assert.ok(calls[0].includes("apiVersion=1"));
    assert.ok(!calls[0].includes("apiVersion=2"));
  });

  it("url-encodes the query", async () => {
    const { c, calls } = client(() => jsonResponse({ results: [] }));

    await c.resolvePlace("Amsterdam Centraal & Co");

    assert.ok(calls[0].includes("Amsterdam%20Centraal%20%26%20Co.json"));
  });

  it("takes the name from poi.name for a POI result", async () => {
    const { c } = client(() =>
      jsonResponse({
        results: [
          {
            type: "POI",
            poi: { name: "Schiphol Airport" },
            address: { freeformAddress: "Evert van de Beekstraat 202, Schiphol" },
            position: { lat: 52.31, lon: 4.76 },
          },
        ],
      }),
    );

    assert.deepEqual(await c.resolvePlace("Schiphol"), { name: "Schiphol Airport", lat: 52.31, lon: 4.76 });
  });

  it("falls back to the freeform address when the result is not a POI", async () => {
    const { c } = client(() =>
      jsonResponse({
        results: [{ type: "Point Address", address: { freeformAddress: "Damrak 1, 1012 LG Amsterdam" }, position: { lat: 52.375, lon: 4.897 } }],
      }),
    );

    assert.deepEqual(await c.resolvePlace("Damrak 1"), { name: "Damrak 1, 1012 LG Amsterdam", lat: 52.375, lon: 4.897 });
  });

  it("returns null rather than throwing when nothing matched", async () => {
    const { c } = client(() => jsonResponse({ results: [] }));

    assert.equal(await c.resolvePlace("Nowherecity Qxz"), null);
  });

  it("reports a rejected credential distinctly", async () => {
    const { c } = client(() => jsonResponse({ detailedError: { message: "Forbidden" } }, 403));

    await assert.rejects(c.resolvePlace("Amsterdam"), CredentialRejectedError);
  });

  it("surfaces TomTom’s own reason on a rejected credential, so an entitlement gap is not read as a bad key", async () => {
    const { c } = client(() => jsonResponse({ detailedError: { code: "Forbidden", message: "You are not allowed to access this endpoint" } }, 403));

    await assert.rejects(c.resolvePlace("Amsterdam"), /not allowed to access this endpoint/);
    await assert.rejects(c.resolvePlace("Amsterdam"), /entitlement/);
  });

  it("reports other upstream failures as a generic upstream error naming the request", async () => {
    const { c } = client(() => jsonResponse({ detailedError: { message: "Internal error" } }, 500));

    await assert.rejects(c.resolvePlace("Amsterdam"), { name: "UpstreamRequestError", request: "geocode", status: 500 });
  });

  it("wraps a transport failure as an upstream error", async () => {
    const { c } = client(() => Promise.reject(new Error("ECONNREFUSED")));

    await assert.rejects(c.resolvePlace("Amsterdam"), UpstreamRequestError);
  });

  it("never puts the API key in the thrown message", async () => {
    const { c } = client(() => jsonResponse("boom", 500));

    await assert.rejects(c.resolvePlace("Amsterdam"), (err: Error) => !err.message.includes(KEY));
  });
});

describe("calculateRoute", () => {
  it("calls the routing endpoint with apiVersion 2 and colon-separated coordinates", async () => {
    const { c, calls } = client(() => jsonResponse(ROUTE_BODY));

    await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT });

    assert.ok(calls[0].includes("/maps/orbis/routing/calculateRoute/52.379,4.899:52.09,5.121/json"));
    assert.ok(calls[0].includes("apiVersion=2"));
    assert.ok(!calls[0].includes("apiVersion=1"));
  });

  it("sends no sectionType and no time parameters by default", async () => {
    const { c, calls } = client(() => jsonResponse(ROUTE_BODY));

    await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT });

    assert.ok(!calls[0].includes("sectionType"));
    assert.ok(!calls[0].includes("departAt"));
    assert.ok(!calls[0].includes("arriveAt"));
  });

  it("passes departAt when given", async () => {
    const { c, calls } = client(() => jsonResponse(ROUTE_BODY));

    await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT, departAt: "2026-08-09T08:00:00Z" });

    assert.ok(calls[0].includes("departAt=2026-08-09T08%3A00%3A00Z"));
    assert.ok(!calls[0].includes("arriveAt"));
  });

  it("passes arriveAt when given", async () => {
    const { c, calls } = client(() => jsonResponse(ROUTE_BODY));

    await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT, arriveAt: "2026-08-09T09:00:00Z" });

    assert.ok(calls[0].includes("arriveAt=2026-08-09T09%3A00%3A00Z"));
    assert.ok(!calls[0].includes("departAt"));
  });

  it("maps the route summary to domain fields", async () => {
    const { c } = client(() => jsonResponse(ROUTE_BODY));

    assert.deepEqual(await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), {
      travelTimeInSeconds: 2400,
      lengthInMeters: 45000,
      trafficDelayInSeconds: 300,
      departureTime: "2026-08-08T12:00:00+02:00",
      arrivalTime: "2026-08-08T12:40:00+02:00",
    });
  });

  it("defaults a missing traffic delay to zero", async () => {
    const { c } = client(() =>
      jsonResponse({
        routes: [{ summary: { travelTimeInSeconds: 100, lengthInMeters: 500, departureTime: "2026-08-08T12:00:00Z", arrivalTime: "2026-08-08T12:01:40Z" } }],
      }),
    );

    const summary = await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT });
    assert.equal(summary.trafficDelayInSeconds, 0);
  });

  it("classifies a NO_ROUTE_FOUND response as no route rather than a generic failure", async () => {
    const { c } = client(() => jsonResponse({ detailedError: { code: "NO_ROUTE_FOUND", message: "no route" } }, 400));

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), NoRouteFoundError);
  });

  it("treats an empty routes array as no route found", async () => {
    const { c } = client(() => jsonResponse({ routes: [] }));

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), NoRouteFoundError);
  });

  it("names the resolved places in the no-route message", async () => {
    const { c } = client(() => jsonResponse({ routes: [] }));

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), /"Amsterdam".*"Utrecht"/);
  });

  it("reports a rejected credential on the route request distinctly", async () => {
    const { c } = client(() => jsonResponse("Unauthorized", 401));

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), { name: "CredentialRejectedError", request: "route" });
  });

  it("reports other routing failures as a generic upstream error", async () => {
    const { c } = client(() => jsonResponse("Service Unavailable", 503));

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), { name: "UpstreamRequestError", request: "route", status: 503 });
  });
});

describe("timeouts and secrecy", () => {
  /** Never answers; rejects only when the request's signal aborts, as real fetch does. */
  const hang = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

  it("gives up on a hung request as an upstream error without status", async () => {
    const { c } = client(hang, { timeoutMs: 10 });

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }), (err: unknown) => {
      assert.ok(err instanceof UpstreamRequestError);
      assert.equal(err.request, "route");
      assert.equal(err.status, undefined);
      assert.match(err.message, /timeout/i);
      return true;
    });
  });

  it("redacts the key from a transport error that quotes the URL", async () => {
    const { c, lines } = client((url) => Promise.reject(new TypeError(`fetch failed for ${url}`)));

    await assert.rejects(c.resolvePlace("Amsterdam"), (err: Error) => !err.message.includes(KEY) && err.message.includes("***"));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => !l.includes(KEY)));
  });

  it("redacts the key from an error body that echoes it", async () => {
    const { c } = client(() => jsonResponse({ error: { description: `bad key ${KEY}` } }, 403));

    await assert.rejects(c.resolvePlace("Amsterdam"), (err: Error) => !err.message.includes(KEY));
  });

  it("never logs the key or the request URL", async () => {
    const { c, lines } = client(() => jsonResponse("boom", 500));

    await assert.rejects(c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT }));
    await assert.rejects(c.resolvePlace("Amsterdam"));

    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => !l.includes(KEY) && !l.includes("api.tomtom.com")));
  });
});

describe("resolution cache", () => {
  it("serves a repeated resolution from the cache", async () => {
    const { c, calls } = client(() => jsonResponse(GEO_BODY));

    await c.resolvePlace("Amsterdam");
    await c.resolvePlace("Amsterdam");

    assert.equal(calls.length, 1);
  });

  it("normalises case and whitespace before caching", async () => {
    const { c, calls } = client(() => jsonResponse(GEO_BODY));

    await c.resolvePlace("Amsterdam");
    await c.resolvePlace("  amsterdam  ");

    assert.equal(calls.length, 1);
  });

  it("caches a not-found result too, so a typo is not re-queried", async () => {
    const { c, calls } = client(() => jsonResponse({ results: [] }));

    await c.resolvePlace("Nowherecity Qxz");
    await c.resolvePlace("Nowherecity Qxz");

    assert.equal(calls.length, 1);
  });

  it("re-queries once the TTL has passed", async () => {
    let clock = 1000;
    const { c, calls } = client(() => jsonResponse(GEO_BODY), { now: () => clock, cacheTtlMs: 500 });

    await c.resolvePlace("Amsterdam");
    clock += 501;
    await c.resolvePlace("Amsterdam");

    assert.equal(calls.length, 2);
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const { c, calls } = client(() => jsonResponse(GEO_BODY), { cacheMaxEntries: 2 });

    await c.resolvePlace("one");
    await c.resolvePlace("two");
    await c.resolvePlace("three");
    // 'one' was evicted, so asking again costs another request.
    await c.resolvePlace("one");

    assert.equal(calls.length, 4);
  });

  it("never caches route results — traffic is the point", async () => {
    const { c, calls } = client(() => jsonResponse(ROUTE_BODY));

    await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT });
    await c.calculateRoute({ origin: AMSTERDAM, destination: UTRECHT });

    assert.equal(calls.length, 2);
  });
});
