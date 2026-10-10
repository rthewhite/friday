import { test } from "node:test";
import assert from "node:assert/strict";
import { actionLabel, changeDetail, settingsPatch, workState, workSummary, type WorkStatus } from "../src/ui/lib/calendar.js";

const dentist = (when: string, location?: string) => ({ title: "Dentist", when, ...(location ? { location } : {}) });

test("actionLabel names the action and the scope", () => {
  assert.equal(actionLabel({ action: "create" }), "Created");
  assert.equal(actionLabel({ action: "update", scope: "series" }), "Changed (whole series)");
  assert.equal(actionLabel({ action: "delete", scope: "occurrence" }), "Deleted (one occurrence)");
  assert.equal(actionLabel({ action: "undo" }), "Undo");
});

test("changeDetail shows the new event for a create, the old one for a delete, and before -> after for an edit", () => {
  assert.equal(changeDetail({ action: "create", before: null, after: dentist("Thu 8 Oct, 14:00-15:00", "Kerkstraat 12") }), '"Dentist" Thu 8 Oct, 14:00-15:00, Kerkstraat 12');
  assert.equal(changeDetail({ action: "delete", before: dentist("Thu 8 Oct, 14:00-15:00"), after: null }), '"Dentist" Thu 8 Oct, 14:00-15:00');
  assert.equal(
    changeDetail({ action: "update", before: dentist("Thu 8 Oct, 14:00-15:00"), after: dentist("Thu 8 Oct, 15:00-16:00") }),
    '"Dentist" Thu 8 Oct, 14:00-15:00 -> "Dentist" Thu 8 Oct, 15:00-16:00',
  );
  assert.equal(changeDetail({ action: "undo", before: dentist("Thu 8 Oct, 14:00-15:00"), after: null }), '"Dentist" Thu 8 Oct, 14:00-15:00 -> (removed)');
  assert.equal(changeDetail({ action: "update", before: dentist("x"), after: dentist("x") }), '"Dentist" x');
});

const work = (over: Partial<WorkStatus> = {}): WorkStatus => ({
  configured: true, receivedAt: "2026-10-03T07:45:00.000Z", events: 218, skipped: 0, coverage: { from: "2026-09-03", to: "2027-04-03" },
  polledAt: "2026-10-03T08:00:00.000Z", ok: true, error: null, warning: null, ...over,
});

test("workState says whether the Work calendar is up to date", () => {
  const now = Date.parse("2026-10-03T08:00:00Z");
  assert.deepEqual(workState(work(), now), { tone: "success", label: "Up to date" });
  assert.deepEqual(workState(work({ configured: false, receivedAt: null }), now), { tone: "neutral", label: "Not configured" });
  assert.deepEqual(workState(work({ ok: false }), now), { tone: "error", label: "Last poll failed" });
  assert.deepEqual(workState(work({ receivedAt: null, events: null }), now), { tone: "warning", label: "Nothing received yet" });
  assert.deepEqual(workState(work({ receivedAt: "2026-10-03T04:00:00.000Z" }), now), { tone: "warning", label: "Out of date" });
});

test("workSummary gives the number of events and the days they cover", () => {
  assert.equal(workSummary(work()), "218 events, 3 Sept 2026 to 3 Apr 2027");
  assert.equal(workSummary(work({ events: 1, skipped: 2, coverage: null })), "1 event (2 left out as invalid)");
  assert.equal(workSummary(work({ events: null })), "");
});

test("settingsPatch builds the PUT body for a toggle or the default", () => {
  assert.deepEqual(settingsPatch({ id: "work" }, { inAgenda: false }), { calendars: { work: { inAgenda: false } } });
  assert.deepEqual(settingsPatch({ id: "work" }, { use: true }), { calendars: { work: { use: true } } });
  assert.deepEqual(settingsPatch({ id: "home" }, { default: true }), { defaultId: "home" });
});
