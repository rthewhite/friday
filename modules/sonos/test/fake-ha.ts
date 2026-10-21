/**
 * A fake Home Assistant for the sonos module: answers the speaker template with the given rows (as
 * the real template renders them) and records every service call. Mirrors the household's speakers.
 */

export interface Row {
  entity: string;
  name: string | null;
  area: string | null;
  model: string | null;
  state: string;
  volume: number | null;
  group: string[] | null;
  title: string | null;
  artist: string | null;
}

export interface ServiceCall {
  service: string;
  data: Record<string, unknown>;
}

export const ARC = "media_player.sonos_arc";
export const PLAYBAR = "media_player.bedroom_sonos_playbar";
export const ONE_SL = "media_player.sonos_one_sl";

export const ARC_NAME = "[Living Room] Sonos ARC";
export const PLAYBAR_NAME = "[Bedroom] Sonos Playbar";
export const ONE_SL_NAME = "[Hobby Room] Sonos";

export function household(): Row[] {
  return [
    { entity: ARC, name: ARC_NAME, area: "Living Room", model: "Arc", state: "idle", volume: 0.16, group: [ARC], title: null, artist: null },
    { entity: PLAYBAR, name: PLAYBAR_NAME, area: "Bedroom", model: "Playbar", state: "paused", volume: 0.14, group: [PLAYBAR], title: null, artist: null },
    { entity: ONE_SL, name: ONE_SL_NAME, area: "Hobby Room", model: "One SL", state: "idle", volume: 0.23, group: [ONE_SL], title: null, artist: null },
  ];
}

/** Put `members` in `leader`'s group (leader first) in the rows. */
export function grouped(rows: Row[], leader: string, ...members: string[]): Row[] {
  const group = [leader, ...members];
  for (const r of rows) if (group.includes(r.entity)) r.group = group;
  return rows;
}

export interface FakeHa {
  fetch: typeof fetch;
  rows: Row[];
  /** Service calls in order, as `domain.service` with their payload. */
  calls: ServiceCall[];
  /** Number of template requests. */
  lookups: number;
  /** Requests seen, for header and URL checks. */
  requests: { url: string; headers: Headers; body: string }[];
}

export interface FakeHaOptions {
  /** Return an HTTP status to fail a service call. */
  fail?: (call: ServiceCall) => number | undefined;
  /** Replace the template response body. */
  templateBody?: string;
  templateStatus?: number;
}

export function fakeHa(rows: Row[] = household(), opts: FakeHaOptions = {}): FakeHa {
  const ha: FakeHa = { rows, calls: [], lookups: 0, requests: [], fetch: undefined as unknown as typeof fetch };
  ha.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = String(init?.body ?? "");
    ha.requests.push({ url: url.toString(), headers: new Headers(init?.headers), body });
    if (url.pathname === "/api/template") {
      ha.lookups++;
      if (opts.templateStatus) return new Response("template error", { status: opts.templateStatus });
      return new Response(opts.templateBody ?? JSON.stringify(ha.rows), { status: 200, headers: { "content-type": "text/plain" } });
    }
    const m = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const call: ServiceCall = { service: `${m[1]}.${m[2]}`, data: JSON.parse(body) as Record<string, unknown> };
      ha.calls.push(call);
      const status = opts.fail?.(call);
      if (status) return new Response(`service failed`, { status });
      return Response.json([]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return ha;
}

export const env = { HA_URL: "http://ha.local/", HA_TOKEN: "ha-secret-token" };
