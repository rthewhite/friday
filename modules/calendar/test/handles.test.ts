import { test } from "node:test";
import assert from "node:assert/strict";
import { UnknownEventError } from "../src/errors.js";
import { EventHandles, HANDLE_TTL_MS, type EventRef } from "../src/handles.js";

function ref(url: string, recurrenceKey?: string): EventRef {
  return { calendarId: "home", objectUrl: url, occurrence: { uid: url, title: "x", allDay: false, startMs: 0, endMs: 0, recurring: !!recurrenceKey, ...(recurrenceKey ? { recurrenceKey } : {}) } };
}

function clock(start = 0) {
  const c = { t: start, now: () => new Date(c.t) };
  return c;
}

test("ids are short, and the same event keeps its id while it is live", () => {
  const c = clock();
  const h = new EventHandles(c.now);
  const id = h.idFor(ref("a"));
  assert.match(id, /^e[a-z2-9]{4}$/);
  c.t += HANDLE_TTL_MS - 1;
  assert.equal(h.idFor(ref("a")), id);
  assert.notEqual(h.idFor(ref("b")), id);
});

test("occurrences of one series get different ids", () => {
  const h = new EventHandles(clock().now);
  assert.notEqual(h.idFor(ref("s", "2026-10-06T09:00:00")), h.idFor(ref("s", "2026-10-13T09:00:00")));
});

test("an id expires two hours after the event was last returned, and returning it again refreshes it", () => {
  const c = clock();
  const h = new EventHandles(c.now);
  const id = h.idFor(ref("a"));
  c.t += HANDLE_TTL_MS - 1000;
  h.idFor(ref("a"));
  c.t += HANDLE_TTL_MS - 1000;
  assert.equal(h.get(id).objectUrl, "a");
  c.t += 2000;
  assert.throws(() => h.get(id), UnknownEventError);
});

test("an unknown id asks to list the events again", () => {
  const h = new EventHandles(clock().now);
  assert.throws(() => h.get("ezzzz"), (e: unknown) => e instanceof UnknownEventError && /calendar_list_events/.test(e.message));
});

test("the oldest handle is dropped beyond the limit", () => {
  const h = new EventHandles(clock().now, HANDLE_TTL_MS, 2);
  const first = h.idFor(ref("a"));
  h.idFor(ref("b"));
  h.idFor(ref("c"));
  assert.throws(() => h.get(first), UnknownEventError);
});

test("the latest ref wins, and ids are matched case-insensitively", () => {
  const h = new EventHandles(clock().now);
  const id = h.idFor(ref("a"));
  h.idFor({ ...ref("a"), calendarId: "work" });
  assert.equal(h.get(id.toUpperCase()).calendarId, "work");
});
