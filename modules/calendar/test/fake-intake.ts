/** A fake intake: queued deliveries that a POST with the right key returns and removes, like the real /out. */
import type { IntakeItem } from "../src/work.js";

export const INTAKE_URL = "http://intake.test:8081/out";
export const INTAKE_KEY = "intake-key-Zm9vYmFyYmF6cXV4";

export interface IntakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
}

export interface Delivery {
  id: string;
  subject: string;
  sender: string;
  received_at: string;
  content: unknown;
}

export class FakeIntake {
  readonly requests: IntakeRequest[] = [];
  queue: Delivery[] = [];
  key = INTAKE_KEY;
  /** When set, answers every request instead of the queue (and leaves the queue alone). */
  respond?: (req: IntakeRequest) => Response | Promise<Response>;
  private seq = 0;

  /** Queue a delivery, as the flow would. */
  deliver(content: unknown, receivedAt: string, subject = "calendar"): Delivery {
    const d = { id: `msg${++this.seq}`, subject, sender: "power-automate", received_at: receivedAt, content };
    this.queue.push(d);
    return d;
  }

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: IntakeRequest = { method: (init?.method ?? "GET").toUpperCase(), url, headers, body: typeof init?.body === "string" ? init.body : undefined, redirect: init?.redirect };
    this.requests.push(req);
    if (init?.signal?.aborted) throw init.signal.reason;
    if (this.respond) return this.respond(req);
    if (req.method !== "POST") return new Response("", { status: 405 });
    if (headers.authorization !== `Bearer ${this.key}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const subject = req.body ? (JSON.parse(req.body) as { subject?: string }).subject : undefined;
    const taken = this.queue.filter((d) => !subject || d.subject === subject);
    this.queue = this.queue.filter((d) => !taken.includes(d));
    return Response.json({ messages: taken });
  }) as typeof fetch;
}

/** A timed meeting as the V3 flow sends it (UTC offsets). */
export function meeting(subject: string, start: string, end: string, extra: Partial<IntakeItem> & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject,
    start,
    end,
    isAllDay: false,
    location: "",
    organizer: "colleague@corp.example",
    showAs: "busy",
    recurrence: "none",
    reccurenceEndDate: null,
    resourceAttendees: "",
    numberOfOccurences: null,
    ...extra,
  };
}

/** An all-day event: midnight UTC to midnight UTC, as the flow sends them. */
export function allDayItem(subject: string, first: string, dayAfterLast: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return meeting(subject, `${first}T00:00:00+00:00`, `${dayAfterLast}T00:00:00+00:00`, { isAllDay: true, ...extra });
}
