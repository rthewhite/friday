import { test } from "node:test";
import assert from "node:assert/strict";
import { actionLabel, changeDetail, settingsPatch } from "../src/ui/lib/calendar.js";

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

test("settingsPatch builds the PUT body for a toggle or the default", () => {
  assert.deepEqual(settingsPatch({ id: "work" }, { inAgenda: false }), { calendars: { work: { inAgenda: false } } });
  assert.deepEqual(settingsPatch({ id: "work" }, { use: true }), { calendars: { work: { use: true } } });
  assert.deepEqual(settingsPatch({ id: "home" }, { default: true }), { defaultId: "home" });
});
