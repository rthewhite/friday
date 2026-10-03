/**
 * A small CalDAV client for iCloud (design D1): discovery, a time-range query, and conditional GET/PUT/DELETE.
 * Credentials are read for every request, so a password saved later is used at once. The Basic header is only
 * ever sent over HTTPS to *.icloud.com, redirects are followed by hand to keep it that way, and nothing that
 * leaves this file (errors, log lines) contains the password or a URL.
 */
import { XMLParser } from "fast-xml-parser";
import type { ModuleLogger } from "@friday/sdk";
import { CredentialRejectedError, PreconditionFailed, ReadOnlyError, UpstreamError } from "./errors.js";

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface Credentials {
  username: string;
  password: string;
}

export interface CalendarInfo {
  /** Last path segment of the collection URL: stable, and short enough for routes. */
  id: string;
  url: string;
  name: string;
  /** `#rrggbb`, when iCloud reports a colour. */
  color?: string;
  writable: boolean;
}

export interface Account {
  username: string;
  /** The account's own calendar addresses (`mailto:` lowercased, without the scheme), plus the username. */
  addresses: string[];
  /** Event calendars in the order iCloud lists them. */
  calendars: CalendarInfo[];
}

export interface CalendarObject {
  url: string;
  etag: string;
  ics: string;
}

export interface CalDavOptions {
  fetch?: typeof fetch;
  credentials: () => Credentials;
  serverUrl?: string;
  log?: ModuleLogger;
  timeoutMs?: number;
}

type Operation = "discovery" | "query" | "read" | "write" | "delete";

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const HOME_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><c:calendar-home-set/><c:calendar-user-address-set/></d:prop></d:propfind>`;
const CALENDARS_BODY =
  `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/>` +
  `<c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/></d:prop></d:propfind>`;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ["response", "propstat", "href", "privilege", "comp"].includes(name),
});

/** True for hosts that may receive the Basic header. */
export function isICloudHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "icloud.com" || url.hostname.endsWith(".icloud.com"));
}

export class CalDavClient {
  private readonly fetchImpl: typeof fetch;
  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  /** Principal and home are fixed per account; cached by username so a changed username rediscovers. */
  private home?: { username: string; homeUrl: string; addresses: string[] };

  constructor(private readonly opts: CalDavOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.serverUrl = opts.serverUrl ?? ICLOUD_CALDAV_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Finds the calendar home (once per username) and lists the event calendars in it (every call). */
  async discover(signal?: AbortSignal): Promise<Account> {
    const { username } = this.opts.credentials();
    if (this.home?.username !== username) {
      const principalRes = await this.multistatus("discovery", "PROPFIND", this.serverUrl, { depth: "0", body: PRINCIPAL_BODY, signal });
      const principalHref = firstHref(findProp(principalRes.responses, "current-user-principal"));
      if (!principalHref) throw new UpstreamError("iCloud did not say where the account's calendars are (no current-user-principal).");
      const principalUrl = new URL(principalHref, principalRes.url).toString();
      const homeRes = await this.multistatus("discovery", "PROPFIND", principalUrl, { depth: "0", body: HOME_BODY, signal });
      const homeHref = firstHref(findProp(homeRes.responses, "calendar-home-set"));
      if (!homeHref) throw new UpstreamError("iCloud did not say where the account's calendars are (no calendar-home-set).");
      const addresses = hrefs(findProp(homeRes.responses, "calendar-user-address-set"))
        .filter((h) => /^mailto:/i.test(h))
        .map((h) => h.replace(/^mailto:/i, "").toLowerCase());
      this.home = { username, homeUrl: new URL(homeHref, homeRes.url).toString(), addresses: [...new Set([...addresses, username.toLowerCase()])] };
    }
    const { homeUrl, addresses } = this.home;
    const listRes = await this.multistatus("discovery", "PROPFIND", homeUrl, { depth: "1", body: CALENDARS_BODY, signal });
    const calendars: CalendarInfo[] = [];
    for (const r of listRes.responses) {
      const props = okProps(r);
      if (!props.resourcetype || typeof props.resourcetype !== "object" || !("calendar" in props.resourcetype)) continue;
      const comps = props["supported-calendar-component-set"]?.comp as { "@_name"?: string }[] | undefined;
      if (comps && !comps.some((c) => c["@_name"]?.toUpperCase() === "VEVENT")) continue;
      const url = new URL(firstHref(r) ?? "", listRes.url).toString();
      const id = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? url);
      const color = normalizeColor(text(props["calendar-color"]));
      calendars.push({ id, url, name: text(props.displayname) || id, ...(color ? { color } : {}), writable: writable(props["current-user-privilege-set"]) });
    }
    return { username, addresses, calendars };
  }

  /** Every event object in `calendarUrl` with an occurrence overlapping [from, to). */
  async query(calendarUrl: string, from: Date, to: Date, signal?: AbortSignal): Promise<CalendarObject[]> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(from)}" end="${utcStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await this.multistatus("query", "REPORT", calendarUrl, { depth: "1", body, signal });
    const out: CalendarObject[] = [];
    for (const r of res.responses) {
      const props = okProps(r);
      const ics = text(props["calendar-data"]);
      const href = firstHref(r);
      if (!ics || !href) continue;
      out.push({ url: new URL(href, res.url).toString(), etag: text(props.getetag), ics });
    }
    return out;
  }

  /** The object at `url`, or null when it doesn't exist. */
  async get(url: string, signal?: AbortSignal): Promise<CalendarObject | null> {
    const res = await this.request("read", "GET", url, { signal });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw this.failure("read", res.status);
    return { url, etag: res.headers.get("etag") ?? "", ics: await res.text() };
  }

  /**
   * Writes `ics` to `url`: over the version with `etag`, or as a new object when `etag` is null. Returns the new
   * ETag, reading it back when iCloud's response carries none. Throws PreconditionFailed when the object changed.
   */
  async put(url: string, ics: string, etag: string | null, signal?: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { "content-type": "text/calendar; charset=utf-8", ...(etag === null ? { "if-none-match": "*" } : { "if-match": etag }) };
    const res = await this.request("write", "PUT", url, { headers, body: ics, signal });
    if (res.status === 412 || (etag !== null && res.status === 404)) throw new PreconditionFailed(res.status);
    if (res.status === 403) throw new ReadOnlyError("iCloud refused the change: this calendar is read-only for this account.");
    if (!res.ok) throw this.failure("write", res.status);
    const tag = res.headers.get("etag");
    if (tag) return tag;
    const back = await this.get(url, signal);
    if (!back) throw new UpstreamError("iCloud accepted the change but the event could not be read back.");
    return back.etag;
  }

  /** Deletes the version of `url` with `etag`. Throws PreconditionFailed when it changed or is gone. */
  async delete(url: string, etag: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request("delete", "DELETE", url, { headers: { "if-match": etag }, signal });
    if (res.status === 412 || res.status === 404) throw new PreconditionFailed(res.status);
    if (res.status === 403) throw new ReadOnlyError("iCloud refused the deletion: this calendar is read-only for this account.");
    if (!res.ok) throw this.failure("delete", res.status);
  }

  private async multistatus(op: Operation, method: string, url: string, o: { depth: string; body: string; signal?: AbortSignal }) {
    const res = await this.request(op, method, url, { headers: { depth: o.depth, "content-type": "application/xml; charset=utf-8" }, body: o.body, signal: o.signal });
    if (res.status !== 207) throw this.failure(op, res.status);
    let doc: any;
    try {
      doc = parser.parse(await res.text());
    } catch {
      throw new UpstreamError(`iCloud's ${op} response could not be read (not XML).`);
    }
    if (!doc || !("multistatus" in doc)) throw new UpstreamError(`iCloud's ${op} response could not be read (no multistatus).`);
    // An empty calendar answers with an empty <multistatus/>.
    const responses = doc.multistatus?.response ?? [];
    return { url: res.url || url, responses: responses as any[] };
  }

  /** One request with credentials, a timeout and hand-followed redirects. `res.url` is set to the final URL. */
  private async request(op: Operation, method: string, url: string, o: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response> {
    const { username, password } = this.opts.credentials();
    let target = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = { ...o.headers };
      if (isICloudHost(target)) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      const signals = [AbortSignal.timeout(this.timeoutMs), ...(o.signal ? [o.signal] : [])];
      let res: Response;
      try {
        res = await this.fetchImpl(target.toString(), { method, headers, body: o.body, redirect: "manual", signal: AbortSignal.any(signals) });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        this.opts.log?.warn(`${op} request ${timedOut ? "timed out or was aborted" : "failed"}: ${e instanceof Error ? e.name : "error"}`);
        throw new UpstreamError(timedOut ? `iCloud did not answer the ${op} request in time.` : `iCloud could not be reached for the ${op} request.`);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw this.failure(op, res.status);
        target = new URL(location, target);
        continue;
      }
      if (res.status === 401) throw new CredentialRejectedError(username);
      Object.defineProperty(res, "url", { value: target.toString() });
      return res;
    }
    throw new UpstreamError(`iCloud redirected the ${op} request too many times.`);
  }

  private failure(op: Operation, status: number): UpstreamError {
    this.opts.log?.warn(`${op} request answered HTTP ${status}`);
    if (status === 429 || status === 503) return new UpstreamError(`iCloud is busy (HTTP ${status}); try again in a minute.`);
    return new UpstreamError(`iCloud's ${op} request failed (HTTP ${status}).`);
  }
}

/** Props of a response's 200 propstat, merged. */
function okProps(response: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const ps of response?.propstat ?? []) {
    if (typeof ps?.status === "string" && !/\s2\d\d\s/.test(ps.status)) continue;
    Object.assign(out, ps?.prop ?? {});
  }
  return out;
}

function findProp(responses: any[], name: string): any {
  for (const r of responses) {
    const v = okProps(r)[name];
    if (v !== undefined) return v;
  }
  return undefined;
}

function hrefs(v: any): string[] {
  return ((v?.href ?? []) as unknown[]).map(text).filter(Boolean);
}

function firstHref(v: any): string | undefined {
  return hrefs(v)[0];
}

/** Text of an element that may carry attributes (`{ "#text": ... }`). */
function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "#text" in v) return String((v as Record<string, unknown>)["#text"]);
  return "";
}

/** Writable unless the privilege set is present and lacks write, write-content and all. */
function writable(set: any): boolean {
  if (!set || typeof set !== "object") return true;
  const privileges = (set.privilege ?? []) as Record<string, unknown>[];
  return privileges.some((p) => p && typeof p === "object" && ("write" in p || "write-content" in p || "all" in p));
}

/** `#RRGGBBAA` or `#RRGGBB` to `#rrggbb`. */
function normalizeColor(c: string): string | undefined {
  const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

/** `YYYYMMDDTHHMMSSZ` */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
