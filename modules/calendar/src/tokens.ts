/**
 * Confirmation tokens (design D4). A preview stores the exact request it would make, under a random 6-character
 * token that works once and only for 5 minutes. Not bound to a conversation: a voice session's first exchange has
 * no conversation id yet.
 */
import { randomInt } from "node:crypto";
import type { CalendarObject } from "./caldav.js";
import { TokenError } from "./errors.js";
import type { Occurrence } from "./ical.js";
import type { EventSummary } from "./service.js";

export const TOKEN_TTL_MS = 5 * 60_000;
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export interface PendingChange {
  action: "update" | "delete";
  scope?: "occurrence" | "series";
  calendarId: string;
  /** The object as it was when previewed; its ETag is the condition for the write. */
  before: CalendarObject;
  /** The object's new text, or null to delete the whole object. */
  ics: string | null;
  occurrence: Occurrence;
  title: string;
  beforeSummary: EventSummary;
  afterSummary?: EventSummary;
  channel?: string;
  conversationId?: string;
}

export class TokenStore {
  private readonly pending = new Map<string, { change: PendingChange; expires: number }>();

  constructor(private readonly now: () => Date, private readonly ttlMs = TOKEN_TTL_MS) {}

  issue(change: PendingChange): { token: string; expiresInSeconds: number } {
    const t = this.now().getTime();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
    let token: string;
    do token = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (this.pending.has(token));
    this.pending.set(token, { change, expires: t + this.ttlMs });
    return { token, expiresInSeconds: Math.round(this.ttlMs / 1000) };
  }

  /** The change behind `token`, removed so it can't be used twice. */
  take(token: string | undefined): PendingChange {
    const key = (token ?? "").trim().toLowerCase();
    const entry = this.pending.get(key);
    if (!entry) throw new TokenError("That confirmation token is unknown or was already used, so nothing changed. Preview the change again.");
    this.pending.delete(key);
    if (entry.expires <= this.now().getTime()) throw new TokenError("That confirmation token expired (they last 5 minutes), so nothing changed. Preview the change again.");
    return entry.change;
  }
}
