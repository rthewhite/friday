/**
 * An in-memory iCloud CalDAV server behind a fake `fetch`, answering with the shapes iCloud uses (default `DAV:`
 * namespace, Apple's calendar-color, absolute calendar-home-set on a pNN host, quoted ETags). Records every
 * request so tests can check headers and that previews send no writes.
 */

export const USERNAME = "me@icloud.com";
export const PASSWORD = "abcd-efgh-ijkl-mnop";
/** iCloud writes the home with an explicit :443; URLs normalise it away. */
const HOME_AS_SENT = "https://p42-caldav.icloud.com:443/1234567/calendars/";
export const HOME = new URL(HOME_AS_SENT).toString();
export const CAL = (id: string) => `${HOME}${id}/`;

export interface FakeCalendar {
  id: string;
  name: string;
  color?: string;
  /** Privileges reported; `undefined` leaves the property out like some iCloud responses do. */
  privileges?: string[];
  components?: string[];
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeICloudOptions {
  password?: string;
  calendars?: FakeCalendar[];
  /** Answer PUT without an ETag header, as iCloud sometimes does. */
  putWithoutEtag?: boolean;
  /** Redirect the first discovery request to this URL (relative to caldav.icloud.com). */
  redirectPrincipalTo?: string;
}

export const DEFAULT_CALENDARS: FakeCalendar[] = [
  { id: "home", name: "Home", color: "#1BADF8FF", privileges: ["read", "write", "write-content"] },
  { id: "work", name: "Work", color: "#FF2968FF", privileges: ["read", "write"] },
  { id: "holidays", name: "Holidays NL", privileges: ["read"] },
  { id: "tasks", name: "Reminders", components: ["VTODO"], privileges: ["read", "write"] },
];

export class FakeICloud {
  readonly requests: RecordedRequest[] = [];
  readonly objects = new Map<string, { ics: string; etag: string }>();
  calendars: FakeCalendar[];
  password: string;
  /** When set, every request fails with this status (or a network error for 0). */
  failWith?: number;
  private seq = 0;
  private redirected = false;

  constructor(private readonly opts: FakeICloudOptions = {}) {
    this.calendars = opts.calendars ?? DEFAULT_CALENDARS;
    this.password = opts.password ?? PASSWORD;
  }

  /** Store an object in a calendar and return its URL. */
  seed(calendarId: string, uid: string, ics: string): string {
    const url = `${CAL(calendarId)}${uid}.ics`;
    this.objects.set(url, { ics, etag: this.nextEtag() });
    return url;
  }

  /** Change an object as if edited on the phone. */
  touch(url: string, ics?: string): void {
    const o = this.objects.get(url);
    if (!o) throw new Error(`no object ${url}`);
    this.objects.set(url, { ics: ics ?? o.ics, etag: this.nextEtag() });
  }

  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "PUT" || r.method === "DELETE");
  }

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.requests.push({ method, url: url.toString(), headers, body });

    if (this.failWith === 0) throw new TypeError("fetch failed");
    if (this.failWith) return new Response("", { status: this.failWith });
    if (url.hostname.endsWith(".icloud.com") || url.hostname === "icloud.com") {
      const expected = `Basic ${Buffer.from(`${USERNAME}:${this.password}`).toString("base64")}`;
      if (headers.authorization !== expected) return new Response("Unauthorized", { status: 401 });
    }
    return this.route(method, url, headers, body);
  }) as typeof fetch;

  private route(method: string, url: URL, headers: Record<string, string>, body?: string): Response {
    const href = url.toString();
    if (method === "PROPFIND" && url.hostname === "caldav.icloud.com" && url.pathname === "/") {
      if (this.opts.redirectPrincipalTo && !this.redirected) {
        this.redirected = true;
        return new Response("", { status: 301, headers: { location: this.opts.redirectPrincipalTo } });
      }
      return ms(`<response><href>/</href>${ok(`<current-user-principal><href>/1234567/principal/</href></current-user-principal>`)}</response>`);
    }
    if (method === "PROPFIND" && url.pathname === "/1234567/principal/") {
      return ms(
        `<response><href>/1234567/principal/</href>${ok(
          `<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${HOME_AS_SENT}</href></calendar-home-set>` +
            `<calendar-user-address-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">mailto:Me@Example.COM</href>` +
            `<href xmlns="DAV:">urn:uuid:0000</href><href xmlns="DAV:">mailto:me@icloud.com</href></calendar-user-address-set>`,
        )}</response>`,
      );
    }
    if (method === "PROPFIND" && href === HOME && headers.depth === "1") {
      const self = `<response><href>/1234567/calendars/</href>${ok(`<resourcetype><collection/></resourcetype>`)}</response>`;
      const inbox = `<response><href>/1234567/calendars/inbox/</href>${ok(`<resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>`)}</response>`;
      const cals = this.calendars.map((c) => {
        const comps = (c.components ?? ["VEVENT"]).map((n) => `<comp name="${n}"/>`).join("");
        const found =
          `<displayname>${c.name}</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>` +
          `<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${comps}</supported-calendar-component-set>` +
          (c.color ? `<calendar-color xmlns="http://apple.com/ns/ical/" symbolic-color="custom">${c.color}</calendar-color>` : "") +
          (c.privileges ? `<current-user-privilege-set>${c.privileges.map((p) => `<privilege><${p}/></privilege>`).join("")}</current-user-privilege-set>` : "");
        const missing = `<propstat><prop>${c.color ? "" : `<calendar-color xmlns="http://apple.com/ns/ical/"/>`}</prop><status>HTTP/1.1 404 Not Found</status></propstat>`;
        return `<response><href>/1234567/calendars/${c.id}/</href>${ok(found)}${missing}</response>`;
      });
      return ms(self + inbox + cals.join(""));
    }
    if (method === "REPORT") {
      const rows = [...this.objects.entries()]
        .filter(([u]) => u.startsWith(href))
        .map(([u, o]) => `<response><href>${new URL(u).pathname}</href>${ok(`<getetag>${o.etag}</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${o.ics}]]></calendar-data>`)}</response>`);
      return ms(rows.join(""));
    }
    if (method === "GET") {
      const o = this.objects.get(href);
      return o ? new Response(o.ics, { status: 200, headers: { etag: o.etag, "content-type": "text/calendar" } }) : new Response("", { status: 404 });
    }
    if (method === "PUT") {
      const cal = this.calendars.find((c) => href.startsWith(CAL(c.id)));
      if (cal?.privileges && !cal.privileges.some((p) => p === "write" || p === "write-content")) return new Response("", { status: 403 });
      const existing = this.objects.get(href);
      if (headers["if-none-match"] === "*" && existing) return new Response("", { status: 412 });
      if (headers["if-match"] && (!existing || existing.etag !== headers["if-match"])) return new Response("", { status: 412 });
      const etag = this.nextEtag();
      this.objects.set(href, { ics: body ?? "", etag });
      return new Response(null, { status: existing ? 204 : 201, headers: this.opts.putWithoutEtag ? {} : { etag } });
    }
    if (method === "DELETE") {
      const existing = this.objects.get(href);
      if (!existing) return new Response("", { status: 404 });
      if (headers["if-match"] && existing.etag !== headers["if-match"]) return new Response("", { status: 412 });
      this.objects.delete(href);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 405 });
  }

  private nextEtag(): string {
    return `"${(++this.seq).toString(16).padStart(8, "0")}"`;
  }
}

const ms = (inner: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${inner}</multistatus>`, { status: 207, headers: { "content-type": "text/xml" } });
const ok = (props: string) => `<propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat>`;

export const AMSTERDAM_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Amsterdam",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19810329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19961027T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

/** A VCALENDAR with Amsterdam's VTIMEZONE around the given VEVENT lines (each event as an array of lines). */
export function vcalendar(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iCloud//EN", AMSTERDAM_TZ, ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
}

/** VEVENT lines for a timed event in Amsterdam time: start/end as `YYYYMMDDTHHMMSS`. */
export function timed(uid: string, summary: string, start: string, end: string, extra: string[] = []): string[] {
  return [`UID:${uid}`, "DTSTAMP:20261001T080000Z", `SUMMARY:${summary}`, `DTSTART;TZID=Europe/Amsterdam:${start}`, `DTEND;TZID=Europe/Amsterdam:${end}`, ...extra];
}

/** VEVENT lines for an all-day event: dates as `YYYYMMDD`, `end` exclusive as iCalendar wants. */
export function allDay(uid: string, summary: string, start: string, endExclusive: string, extra: string[] = []): string[] {
  return [`UID:${uid}`, "DTSTAMP:20261001T080000Z", `SUMMARY:${summary}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${endExclusive}`, ...extra];
}
