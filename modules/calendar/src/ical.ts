/**
 * iCalendar on ical.js (design D2): parse iCloud's objects, expand recurring events into occurrences, build new
 * events, and apply edits and occurrence deletions to the parsed object so everything Friday doesn't touch
 * (alarms, attendees, X-APPLE-* properties) survives as it was.
 *
 * Times: a TZID that names an IANA zone is resolved with Intl, other TZIDs through the object's own VTIMEZONE,
 * and floating times in the household zone.
 */
import ICAL from "ical.js";
import { parseDateTime, resolveTimeZone, startOfLocalDay } from "@friday/sdk";
import { UpstreamError } from "./errors.js";
import { addDays, wallClock, type Span } from "./format.js";
import { vtimezoneLines } from "./vtimezone.js";

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;

/** Expanding a series stops after this many occurrences, whatever the range. */
const MAX_OCCURRENCES = 50_000;

export interface Occurrence extends Span {
  uid: string;
  title: string;
  location?: string;
  notes?: string;
  recurring: boolean;
  /** For an occurrence of a recurring event: its original start as ical.js writes it (`2026-10-13T09:00:00`). */
  recurrenceKey?: string;
  /** Organizer's address, lowercased and without `mailto:`. */
  organizer?: string;
}

export interface ParsedObject {
  vcal: Component;
  master?: Component;
  overrides: Component[];
}

export type Repeat = "daily" | "weekly" | "monthly" | "yearly";

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (t: Time) => `${String(t.year).padStart(4, "0")}-${pad(t.month)}-${pad(t.day)}`;

export function parseIcs(ics: string): ParsedObject {
  let vcal: Component;
  try {
    vcal = new ICAL.Component(ICAL.parse(ics) as any[]);
  } catch {
    throw new UpstreamError("An event from iCloud could not be read (invalid iCalendar data).");
  }
  // Registered before any time is read, so TZIDs without an IANA name resolve through the object's own rules.
  for (const tz of vcal.getAllSubcomponents("vtimezone")) {
    const id = tz.getFirstPropertyValue("tzid");
    if (typeof id === "string" && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(tz);
  }
  const events = vcal.getAllSubcomponents("vevent");
  return { vcal, master: events.find((e) => !e.hasProperty("recurrence-id")), overrides: events.filter((e) => e.hasProperty("recurrence-id")) };
}

function tzidOf(prop: Property | null | undefined): string | undefined {
  const v = prop?.getParameter("tzid");
  return typeof v === "string" && v.trim() ? v : undefined;
}

const isIana = (tzid: string | undefined): tzid is string => !!tzid && resolveTimeZone(tzid).valid;
const isUtc = (t: Time) => t.zone?.tzid === "UTC";

/** The instant of an iCalendar time; dates are the start of that day in `zone`. */
export function instantOf(t: Time, tzid: string | undefined, zone: string): number {
  if (t.isDate) return startOfLocalDay(dateOf(t), zone)!.getTime();
  if (isUtc(t)) return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  const wall = `${dateOf(t)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
  if (isIana(tzid)) return parseDateTime(wall, tzid)!.instant;
  if (tzid && t.zone && t.zone !== ICAL.Timezone.localTimezone) return t.toUnixTime() * 1000;
  return parseDateTime(wall, zone)!.instant;
}

function spanOf(start: Time, end: Time | null, startTzid: string | undefined, endTzid: string | undefined, zone: string): Span {
  if (start.isDate) {
    const startDate = dateOf(start);
    let endDate = end?.isDate ? dateOf(end) : addDays(startDate, 1);
    if (endDate <= startDate) endDate = addDays(startDate, 1);
    return { allDay: true, startDate, endDate, startMs: startOfLocalDay(startDate, zone)!.getTime(), endMs: startOfLocalDay(endDate, zone)!.getTime() };
  }
  const startMs = instantOf(start, startTzid, zone);
  const endMs = end ? instantOf(end, endTzid ?? startTzid, zone) : startMs;
  return { allDay: false, startMs, endMs: Math.max(endMs, startMs) };
}

/** Start and end of one VEVENT, with DURATION or a missing DTEND handled as RFC 5545 says. */
function componentSpan(comp: Component, zone: string): Span {
  const ev = new ICAL.Event(comp, { exceptions: [] });
  const startProp = comp.getFirstProperty("dtstart");
  const endProp = comp.getFirstProperty("dtend");
  return spanOf(ev.startDate, ev.endDate, tzidOf(startProp), tzidOf(endProp) ?? tzidOf(startProp), zone);
}

function text(comp: Component, name: string): string | undefined {
  const v = comp.getFirstPropertyValue(name);
  return typeof v === "string" && v.trim() ? v : undefined;
}

function details(comp: Component, uid: string) {
  const organizer = text(comp, "organizer");
  return {
    uid,
    title: text(comp, "summary") ?? "(no title)",
    ...(text(comp, "location") ? { location: text(comp, "location") } : {}),
    ...(text(comp, "description") ? { notes: text(comp, "description") } : {}),
    ...(organizer ? { organizer: organizer.replace(/^mailto:/i, "").toLowerCase() } : {}),
  };
}

const cancelled = (comp: Component) => String(comp.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
const overlaps = (s: Span, from: number, to: number) => (s.endMs > s.startMs ? s.startMs < to && s.endMs > from : s.startMs >= from && s.startMs < to);

/** The original start of an override, as an instant. */
function recurrenceMs(override: Component, zone: string): number {
  const prop = override.getFirstProperty("recurrence-id")!;
  return instantOf(prop.getFirstValue() as Time, tzidOf(prop), zone);
}

/** Every occurrence of the object's event that overlaps [from, to), cancelled ones left out. */
export function expand(parsed: ParsedObject, from: number, to: number, zone: string): Occurrence[] {
  const out: Occurrence[] = [];
  const { master, overrides } = parsed;
  if (!master) {
    // Lone instances of someone else's series, as invitations sometimes arrive.
    for (const o of overrides) {
      const span = componentSpan(o, zone);
      if (!cancelled(o) && overlaps(span, from, to)) out.push({ ...details(o, text(o, "uid") ?? ""), ...span, recurring: true, recurrenceKey: (o.getFirstPropertyValue("recurrence-id") as Time).toString() });
    }
    return out;
  }
  const uid = text(master, "uid") ?? "";
  const event = new ICAL.Event(master, { exceptions: overrides });
  if (!event.isRecurring()) {
    const span = componentSpan(master, zone);
    if (!cancelled(master) && overlaps(span, from, to)) out.push({ ...details(master, uid), ...span, recurring: false });
    return out;
  }
  const startTzid = tzidOf(master.getFirstProperty("dtstart"));
  const seen = new Set<number>();
  // Occurrences ending well before the range are skipped without working out their details, unless an override
  // may have moved them into it. A day of slack covers DST and all-day spans.
  const masterSpan = componentSpan(master, zone);
  const reach = masterSpan.endMs - masterSpan.startMs + 86_400_000;
  const overridden = new Set(overrides.map((o) => recurrenceMs(o, zone)));
  const it = event.iterator();
  for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
    const originalMs = instantOf(next, startTzid, zone);
    if (originalMs >= to) break;
    seen.add(originalMs);
    if (originalMs + reach < from && !overridden.has(originalMs)) continue;
    const occ = event.getOccurrenceDetails(next);
    const comp = occ.item.component;
    if (cancelled(comp)) continue;
    const tz = comp === master ? startTzid : tzidOf(comp.getFirstProperty("dtstart"));
    const endTz = comp === master ? tzidOf(master.getFirstProperty("dtend")) ?? startTzid : tzidOf(comp.getFirstProperty("dtend")) ?? tz;
    const span = spanOf(occ.startDate, occ.endDate, tz, endTz, zone);
    if (overlaps(span, from, to)) out.push({ ...details(comp, uid), ...span, recurring: true, recurrenceKey: next.toString() });
  }
  // Occurrences whose original start lies past the range but that were moved into it.
  for (const o of overrides) {
    if (seen.has(recurrenceMs(o, zone)) || cancelled(o)) continue;
    const span = componentSpan(o, zone);
    if (overlaps(span, from, to)) out.push({ ...details(o, uid), ...span, recurring: true, recurrenceKey: (o.getFirstPropertyValue("recurrence-id") as Time).toString() });
  }
  return out;
}

/**
 * The occurrence a handle points at, in a freshly fetched object: the event itself for a non-recurring one, or the
 * occurrence originally at `recurrenceKey`. Undefined when it no longer exists (deleted, cancelled, or the event
 * became recurring or stopped being so).
 */
export function findOccurrence(parsed: ParsedObject, recurrenceKey: string | undefined, zone: string): Occurrence | undefined {
  const { master } = parsed;
  if (recurrenceKey === undefined) {
    if (!master || new ICAL.Event(master, { exceptions: [] }).isRecurring() || cancelled(master)) return undefined;
    return { ...details(master, text(master, "uid") ?? ""), ...componentSpan(master, zone), recurring: false };
  }
  if (!master) {
    const o = parsed.overrides.find((c) => (c.getFirstPropertyValue("recurrence-id") as Time).toString() === recurrenceKey);
    return o && !cancelled(o) ? { ...details(o, text(o, "uid") ?? ""), ...componentSpan(o, zone), recurring: true, recurrenceKey } : undefined;
  }
  const override = findOverride(parsed, recurrenceKey, zone);
  if (override) return cancelled(override) ? undefined : { ...details(override, text(master, "uid") ?? ""), ...componentSpan(override, zone), recurring: true, recurrenceKey };
  const at = recurrenceInstant(parsed, recurrenceKey, zone);
  return expand(parsed, at, at + 1, zone).find((o) => o.recurrenceKey === recurrenceKey);
}

/** True when the event's organizer is someone other than the account. */
export function isInvitation(o: Pick<Occurrence, "organizer">, ownAddresses: string[]): boolean {
  return !!o.organizer && !ownAddresses.includes(o.organizer);
}

// ---- Writing -------------------------------------------------------------------------------------------------

function timeAt(ms: number, zone: string): Time {
  const w = wallClock(ms, zone);
  const [y, m, d] = w.date.split("-").map(Number);
  const [hh, mm] = w.time.split(":").map(Number);
  return ICAL.Time.fromData({ year: y, month: m, day: d, hour: hh, minute: mm, second: Number(w.seconds), isDate: false });
}

function dateTime(date: string): Time {
  const [y, m, d] = date.split("-").map(Number);
  return ICAL.Time.fromData({ year: y, month: m, day: d, isDate: true });
}

/** Replaces `name` with a date-time at `ms`: in `tzid` when given, else in UTC. */
function setDateTime(comp: Component, name: string, ms: number, tzid: string | undefined): void {
  comp.removeAllProperties(name);
  const prop = new ICAL.Property(name);
  if (tzid) {
    prop.setValue(timeAt(ms, tzid));
    prop.setParameter("tzid", tzid);
  } else {
    const t = ICAL.Time.fromJSDate(new Date(ms), true);
    prop.setValue(t);
  }
  comp.addProperty(prop);
}

function setDate(comp: Component, name: string, date: string): void {
  comp.removeAllProperties(name);
  comp.addPropertyWithValue(name, dateTime(date));
}

/** Sets DTSTART/DTEND (dropping DURATION) for `span`, timed ones in `tzid` (UTC when undefined). */
function setSpan(comp: Component, span: Span, tzid: string | undefined): void {
  comp.removeAllProperties("duration");
  if (span.allDay) {
    setDate(comp, "dtstart", span.startDate!);
    setDate(comp, "dtend", span.endDate!);
  } else {
    setDateTime(comp, "dtstart", span.startMs, tzid);
    setDateTime(comp, "dtend", span.endMs, tzid);
  }
}

function setText(comp: Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  comp.removeAllProperties(name);
  if (value !== null && value !== "") comp.addPropertyWithValue(name, value);
}

function stamp(comp: Component, now: Date): void {
  const t = ICAL.Time.fromJSDate(now, true);
  comp.updatePropertyWithValue("dtstamp", t);
  comp.updatePropertyWithValue("last-modified", t);
  const seq = Number(comp.getFirstPropertyValue("sequence") ?? 0);
  comp.updatePropertyWithValue("sequence", Number.isFinite(seq) ? seq + 1 : 1);
}

/** Adds a generated VTIMEZONE for `zone` unless the calendar already has one with that TZID. */
function ensureVTimezone(vcal: Component, zone: string, year: number): void {
  if (vcal.getAllSubcomponents("vtimezone").some((tz) => tz.getFirstPropertyValue("tzid") === zone)) return;
  const tz = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", ...vtimezoneLines(zone, year), "END:VCALENDAR"].join("\r\n")) as any[]).getFirstSubcomponent("vtimezone")!;
  // Conventionally before the events.
  const events = vcal.getAllSubcomponents("vevent");
  for (const e of events) vcal.removeSubcomponent(e);
  vcal.addSubcomponent(tz);
  for (const e of events) vcal.addSubcomponent(e);
}

/** The zone to write timed values in: UTC for UTC zones, else the zone itself (with a VTIMEZONE). */
const writeZone = (zone: string) => (/^(etc\/)?(utc|uct|gmt|zulu)$/i.test(zone) ? undefined : zone);

export interface NewEvent {
  uid: string;
  title: string;
  span: Span;
  location?: string;
  notes?: string;
  repeat?: Repeat;
  /** Last day of the repetition, `YYYY-MM-DD`, inclusive. */
  repeatUntil?: string;
  zone: string;
  now: Date;
}

export function buildEvent(e: NewEvent): string {
  const vcal = new ICAL.Component(["vcalendar", [], []]);
  vcal.addPropertyWithValue("version", "2.0");
  vcal.addPropertyWithValue("prodid", "-//Friday//Calendar//EN");
  vcal.addPropertyWithValue("calscale", "GREGORIAN");
  const ev = new ICAL.Component("vevent");
  ev.addPropertyWithValue("uid", e.uid);
  const now = ICAL.Time.fromJSDate(e.now, true);
  ev.addPropertyWithValue("dtstamp", now);
  ev.addPropertyWithValue("created", now);
  ev.addPropertyWithValue("last-modified", now);
  ev.addPropertyWithValue("summary", e.title);
  const tzid = writeZone(e.zone);
  setSpan(ev, e.span, tzid);
  setText(ev, "location", e.location);
  setText(ev, "description", e.notes);
  if (e.repeat) {
    let rule = `FREQ=${e.repeat.toUpperCase()}`;
    if (e.repeatUntil) {
      rule += e.span.allDay
        ? `;UNTIL=${e.repeatUntil.replace(/-/g, "")}`
        : `;UNTIL=${new Date(startOfLocalDay(addDays(e.repeatUntil, 1), e.zone)!.getTime() - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
    }
    ev.addPropertyWithValue("rrule", ICAL.Recur.fromString(rule));
  }
  vcal.addSubcomponent(ev);
  if (!e.span.allDay && tzid) ensureVTimezone(vcal, tzid, Number(wallClock(e.span.startMs, e.zone).date.slice(0, 4)));
  return vcal.toString();
}

/** The override for the occurrence originally at `recurrenceKey`, if there is one. */
function findOverride(parsed: ParsedObject, recurrenceKey: string, zone: string): Component | undefined {
  const target = recurrenceInstant(parsed, recurrenceKey, zone);
  return parsed.overrides.find((o) => recurrenceMs(o, zone) === target);
}

function recurrenceInstant(parsed: ParsedObject, recurrenceKey: string, zone: string): number {
  const master = parsed.master!;
  const startProp = master.getFirstProperty("dtstart");
  const t = ICAL.Time.fromString(recurrenceKey, startProp);
  return instantOf(t, recurrenceKey.endsWith("Z") ? undefined : tzidOf(startProp), zone);
}

/** A RECURRENCE-ID or EXDATE property for `recurrenceKey`, in the same form as the master's DTSTART. */
function recurrenceProp(parsed: ParsedObject, name: string, recurrenceKey: string): Property {
  const startProp = parsed.master!.getFirstProperty("dtstart")!;
  const prop = new ICAL.Property(name);
  prop.setValue(ICAL.Time.fromString(recurrenceKey, startProp));
  const tzid = tzidOf(startProp);
  if (tzid && !recurrenceKey.endsWith("Z")) prop.setParameter("tzid", tzid);
  return prop;
}

/** The TZID an edited component's times are written in: its own IANA zone, UTC when it was in UTC, else the household's. */
function editZone(comp: Component, zone: string): string | undefined {
  const startProp = comp.getFirstProperty("dtstart");
  const tzid = tzidOf(startProp);
  if (isIana(tzid)) return tzid;
  const t = startProp?.getFirstValue() as Time | undefined;
  if (t && !t.isDate && isUtc(t)) return undefined;
  return writeZone(zone);
}

export interface EditChanges {
  title?: string;
  /** `null` or "" clears it. */
  location?: string | null;
  notes?: string | null;
  /** The occurrence's new start and end, when its time changes. */
  span?: Span;
}

export interface EditTarget {
  /** The occurrence as it was listed. */
  occurrence: Occurrence;
  scope?: "occurrence" | "series";
}

function applyText(comp: Component, ch: EditChanges): void {
  if (ch.title !== undefined) setText(comp, "summary", ch.title);
  setText(comp, "location", ch.location);
  setText(comp, "description", ch.notes);
}

/** Thrown for edits Friday doesn't make; the service words the message. */
export class EditRefused extends Error {}

/** The object's ICS with the change applied. Series edits move every occurrence by the same time-of-day shift. */
export function applyEdit(parsed: ParsedObject, target: EditTarget, ch: EditChanges, zone: string, now: Date): string {
  const { master, vcal } = parsed;
  const occ = target.occurrence;
  if (!master) throw new EditRefused("no master event");

  // Sets a component's span in its edit zone, adding a VTIMEZONE when that zone has none in the object yet.
  const respan = (comp: Component, span: Span, tz = editZone(comp, zone)) => {
    setSpan(comp, span, tz);
    if (tz && !span.allDay) ensureVTimezone(vcal, tz, Number(wallClock(span.startMs, zone).date.slice(0, 4)));
  };

  if (!occ.recurring) {
    applyText(master, ch);
    if (ch.span) respan(master, ch.span);
    stamp(master, now);
    return vcal.toString();
  }

  if (target.scope === "occurrence") {
    let override = findOverride(parsed, occ.recurrenceKey!, zone);
    if (!override) {
      // toJSON() is the master's own jCal; copy it, or the override would be the master.
      override = new ICAL.Component(structuredClone(master.toJSON()) as any[]);
      for (const name of ["rrule", "rdate", "exdate", "recurrence-id"]) override.removeAllProperties(name);
      override.addProperty(recurrenceProp(parsed, "recurrence-id", occ.recurrenceKey!));
      respan(override, occ, editZone(master, zone));
      vcal.addSubcomponent(override);
    }
    applyText(override, ch);
    if (ch.span) respan(override, ch.span);
    stamp(override, now);
    return vcal.toString();
  }

  // Series: text on the master, and on overrides that still had the master's old value.
  for (const [field, name] of [["title", "summary"], ["location", "location"], ["notes", "description"]] as const) {
    const value = ch[field];
    if (value === undefined) continue;
    const old = text(master, name);
    for (const o of parsed.overrides) if (text(o, name) === old) setText(o, name, value);
    setText(master, name, value);
  }
  if (ch.span) {
    if (occ.allDay || ch.span.allDay) throw new EditRefused("all-day series dates");
    const listed = wallClock(occ.startMs, zone), after = wallClock(ch.span.startMs, zone);
    if (listed.date !== after.date) throw new EditRefused("series date change");
    // The shift is measured from where the series puts this occurrence, which differs from where it was listed
    // when this occurrence was moved on its own; that one is placed at the new time explicitly below.
    const original = wallClock(recurrenceInstant(parsed, occ.recurrenceKey!, zone), zone);
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const shift = minutes(after.time) - minutes(original.time);
    const duration = Math.round((ch.span.endMs - ch.span.startMs) / 60_000);
    const picked = findOverride(parsed, occ.recurrenceKey!, zone);
    const adjust = (prop: Property | null) => {
      if (!prop) return;
      // RDATE may hold periods; only date-times move.
      const values = prop.getValues().map((v: unknown) => {
        if (!(v instanceof ICAL.Time) || v.isDate) return v;
        const t = v.clone();
        t.adjust(0, 0, shift, 0);
        return t;
      });
      if (prop.isMultiValue) prop.setValues(values);
      else prop.setValue(values[0]);
    };
    const startProp = master.getFirstProperty("dtstart")!;
    adjust(startProp);
    master.removeAllProperties("duration");
    master.removeAllProperties("dtend");
    const end = (startProp.getFirstValue() as Time).clone();
    end.adjust(0, 0, duration, 0);
    const endProp = new ICAL.Property("dtend");
    endProp.setValue(end);
    const tzid = tzidOf(startProp);
    if (tzid) endProp.setParameter("tzid", tzid);
    master.addProperty(endProp);
    for (const ex of master.getAllProperties("exdate")) adjust(ex);
    for (const rd of master.getAllProperties("rdate")) adjust(rd);
    // A date-time UNTIL moves too, or a later series would lose its last occurrence.
    for (const rr of master.getAllProperties("rrule")) {
      const recur = rr.getFirstValue() as InstanceType<typeof ICAL.Recur>;
      if (recur.until && !recur.until.isDate) {
        recur.until.adjust(0, 0, shift, 0);
        rr.setValue(recur);
      }
    }
    for (const o of parsed.overrides) {
      const rid = o.getFirstProperty("recurrence-id")!;
      const unmoved = (o.getFirstPropertyValue("dtstart") as Time).toString() === (rid.getFirstValue() as Time).toString();
      adjust(rid);
      if (o === picked && !unmoved) respan(o, ch.span);
      else if (unmoved) {
        adjust(o.getFirstProperty("dtstart"));
        adjust(o.getFirstProperty("dtend"));
      }
      stamp(o, now);
    }
  }
  stamp(master, now);
  return vcal.toString();
}

/** The object's ICS with one occurrence removed: an EXDATE on the master, and its override (if any) dropped. */
export function deleteOccurrence(parsed: ParsedObject, recurrenceKey: string, zone: string, now: Date): string {
  const { master, vcal } = parsed;
  if (!master) throw new EditRefused("no master event");
  const override = findOverride(parsed, recurrenceKey, zone);
  if (override) vcal.removeSubcomponent(override);
  master.addProperty(recurrenceProp(parsed, "exdate", recurrenceKey));
  stamp(master, now);
  return vcal.toString();
}
