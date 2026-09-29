import type { ModuleLogger } from "@friday/sdk";
import {
  CredentialRejectedError,
  NoRouteFoundError,
  UpstreamRequestError,
  type UpstreamRequest,
} from "./errors.js";
import type { ResolvedPlace, RouteRequest, RouteSummary, TomTomClient } from "./types.js";

const BASE_URL = "https://api.tomtom.com";

// These two versions differ on purpose and are NOT a copy-paste mistake: on Orbis
// Maps the routing service is at apiVersion 2 while places/search is still at
// apiVersion 1. Aligning them "for consistency" breaks whichever one you change.
const ROUTING_API_VERSION = "2";
const PLACES_API_VERSION = "1";

// Coordinates are effectively static and "home → work" gets asked over and over,
// so resolutions are cached. Route results never are: traffic is the whole point.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// A hung request would otherwise hold the voice turn until the tool call times out.
const REQUEST_TIMEOUT_MS = 10_000;

export interface TomTomClientOptions {
  fetchImpl?: typeof fetch;
  log?: ModuleLogger;
  now?: () => number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  timeoutMs?: number;
}

interface CacheEntry {
  place: ResolvedPlace | null;
  expiresAt: number;
}

export function createTomTomClient(apiKey: string, options: TomTomClientOptions = {}): TomTomClient {
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? console;
  const now = options.now ?? Date.now;
  const ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  const maxEntries = options.cacheMaxEntries ?? CACHE_MAX_ENTRIES;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const cache = new Map<string, CacheEntry>();

  function cacheGet(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  }

  function cacheSet(key: string, place: ResolvedPlace | null): void {
    // Insertion-ordered Map, so the first key is the oldest.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { place, expiresAt: now() + ttlMs });
  }

  /**
   * The key is a query parameter, so anything that might quote the request URL
   * (a transport error, an echoing error body) goes through here first.
   */
  function redact(text: string): string {
    if (!apiKey) return text;
    return text.split(apiKey).join("***").split(encodeURIComponent(apiKey)).join("***");
  }

  /**
   * Turns a non-OK response into the right error type. Reads the body for a
   * TomTom detail message, but never logs or echoes the request URL — the API key
   * is a query parameter on it.
   */
  function fail(request: UpstreamRequest, status: number, body: string, context: Record<string, unknown>): never {
    log.error(`TomTom ${request} request failed`, { request, status, ...context });

    const detail = redact(extractDetail(body));
    if (status === 401 || status === 403) {
      throw new CredentialRejectedError(request, status, detail);
    }
    throw new UpstreamRequestError(request, status, detail);
  }

  async function send(request: UpstreamRequest, url: string, context: Record<string, unknown>): Promise<Response> {
    try {
      return await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const cause = redact(describeCause(err));
      log.error(`TomTom ${request} request could not be sent`, { ...context, cause });
      throw new UpstreamRequestError(request, undefined, cause);
    }
  }

  async function resolvePlace(query: string): Promise<ResolvedPlace | null> {
    const key = normaliseQuery(query);
    const cached = cacheGet(key);
    if (cached) return cached.place;

    const url =
      `${BASE_URL}/maps/orbis/places/search/${encodeURIComponent(query)}.json` +
      `?apiVersion=${PLACES_API_VERSION}&limit=1&key=${encodeURIComponent(apiKey)}`;

    const res = await send("geocode", url, { query });
    if (!res.ok) fail("geocode", res.status, await readBody(res), { query });

    const body = (await res.json()) as SearchResponse;
    const top = body.results?.[0];

    // No match is a normal outcome, not a failure — the handler turns it into an
    // error that names which parameter the user needs to rephrase.
    if (!top?.position) {
      cacheSet(key, null);
      return null;
    }

    const place: ResolvedPlace = {
      name: placeName(top, query),
      lat: top.position.lat,
      lon: top.position.lon,
    };
    cacheSet(key, place);
    return place;
  }

  async function calculateRoute({ origin, destination, departAt, arriveAt }: RouteRequest): Promise<RouteSummary> {
    const locations = `${origin.lat},${origin.lon}:${destination.lat},${destination.lon}`;
    const params = new URLSearchParams({ apiVersion: ROUTING_API_VERSION, key: apiKey });
    // Deliberately no sectionType: Orbis has no default for it and we want none.
    if (departAt) params.set("departAt", departAt);
    if (arriveAt) params.set("arriveAt", arriveAt);

    const url = `${BASE_URL}/maps/orbis/routing/calculateRoute/${locations}/json?${params.toString()}`;
    const logContext = { origin: origin.name, destination: destination.name, departAt, arriveAt };

    const res = await send("route", url, logContext);
    if (!res.ok) {
      // TomTom reports an unroutable pair as a 4xx with a detailedError code
      // rather than an empty success, so this has to be sniffed before the
      // generic classification.
      const errorBody = await readBody(res);
      if (/NO_ROUTE_FOUND/i.test(errorBody)) {
        log.log("TomTom found no drivable route", logContext);
        throw new NoRouteFoundError(origin.name, destination.name);
      }
      fail("route", res.status, errorBody, logContext);
    }

    const body = (await res.json()) as RouteResponse;
    const summary = body.routes?.[0]?.summary;
    if (!summary) {
      throw new NoRouteFoundError(origin.name, destination.name);
    }

    return {
      travelTimeInSeconds: summary.travelTimeInSeconds,
      lengthInMeters: summary.lengthInMeters,
      trafficDelayInSeconds: summary.trafficDelayInSeconds ?? 0,
      departureTime: summary.departureTime,
      arrivalTime: summary.arrivalTime,
    };
  }

  return { resolvePlace, calculateRoute };
}

function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fuzzy Search returns POIs and addresses in one list, and the display name lives
 * in a different field for each.
 */
function placeName(result: SearchResult, fallback: string): string {
  if (result.poi?.name) return result.poi.name;
  return result.address?.freeformAddress ?? fallback;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function extractDetail(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { detailedError?: { message?: string }; error?: { description?: string } };
    return parsed.detailedError?.message ?? parsed.error?.description ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

function describeCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SearchResult {
  type?: string;
  poi?: { name?: string };
  address?: { freeformAddress?: string };
  position?: { lat: number; lon: number };
}

interface SearchResponse {
  results?: SearchResult[];
}

interface RouteResponse {
  routes?: {
    summary?: {
      travelTimeInSeconds: number;
      lengthInMeters: number;
      trafficDelayInSeconds?: number;
      departureTime: string;
      arrivalTime: string;
    };
  }[];
}
