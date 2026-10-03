/**
 * Short event ids (design D3). Tools hand out `e7k2`-style ids instead of CalDAV URLs: easy for a voice model to
 * copy, impossible to aim at an event Friday never listed. Kept in memory, LRU-bounded, and alive for two hours
 * after the event was last returned.
 */
import { randomInt } from "node:crypto";
import { UnknownEventError } from "./errors.js";
import type { Occurrence } from "./ical.js";

export interface EventRef {
  calendarId: string;
  objectUrl: string;
  etag: string;
  /** The occurrence as last returned. */
  occurrence: Occurrence;
}

export const HANDLE_TTL_MS = 2 * 60 * 60_000;
export const MAX_HANDLES = 1000;
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

const keyOf = (r: Pick<EventRef, "objectUrl" | "occurrence">) => `${r.objectUrl}#${r.occurrence.recurrenceKey ?? ""}`;

export class EventHandles {
  private readonly byId = new Map<string, { ref: EventRef; seen: number }>();
  private readonly idByKey = new Map<string, string>();

  constructor(private readonly now: () => Date, private readonly ttlMs = HANDLE_TTL_MS, private readonly max = MAX_HANDLES) {}

  /** The id for this event (the same one while it is live), refreshed and pointing at `ref`. */
  idFor(ref: EventRef): string {
    const key = keyOf(ref);
    let id = this.idByKey.get(key);
    if (id && !this.live(id)) id = undefined;
    if (!id) {
      do id = `e${Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
      while (this.byId.has(id));
      this.idByKey.set(key, id);
    }
    this.byId.delete(id);
    this.byId.set(id, { ref, seen: this.now().getTime() });
    while (this.byId.size > this.max) this.drop(this.byId.keys().next().value!);
    return id;
  }

  /** The event behind `id`; UnknownEventError when Friday never gave it out or it expired. */
  get(id: string): EventRef {
    const key = typeof id === "string" ? id.trim().toLowerCase() : "";
    if (!this.live(key)) throw new UnknownEventError(String(id));
    return this.byId.get(key)!.ref;
  }

  private live(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    if (this.now().getTime() - entry.seen > this.ttlMs) {
      this.drop(id);
      return false;
    }
    return true;
  }

  private drop(id: string): void {
    const entry = this.byId.get(id);
    if (entry) this.idByKey.delete(keyOf(entry.ref));
    this.byId.delete(id);
  }
}
