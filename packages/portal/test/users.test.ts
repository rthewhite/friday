import { test } from "node:test";
import assert from "node:assert/strict";
import { actionFor, sortUsers, statusTone, type UserEntry } from "../src/lib/users.js";

const user = (over: Partial<UserEntry>): UserEntry => ({ id: "u", name: "U", email: null, role: "member", owner: false, disabled: false, firstLoginAt: "t", lastLoginAt: "t", ...over });

test("Disable is offered for others, not for yourself or the dev user; Enable for anyone disabled", () => {
  assert.equal(actionFor(user({ id: "u2" }), "u1"), "disable");
  assert.equal(actionFor(user({ id: "u1" }), "u1"), null, "your own row");
  assert.equal(actionFor(user({ id: "dev" }), "u1"), null, "the dev user");
  assert.equal(actionFor(user({ id: "u2", disabled: true }), "u1"), "enable");
  assert.equal(actionFor(user({ id: "u2" }), undefined), "disable");
});

test("status and order: disabled users are red; admins come first, then by name", () => {
  assert.equal(statusTone(user({ disabled: true })), "error");
  assert.equal(statusTone(user({})), "success");
  const sorted = sortUsers([user({ id: "1", name: "Zoë" }), user({ id: "2", name: "Bram", role: "admin" }), user({ id: "3", name: "Anouk" })]);
  assert.deepEqual(sorted.map((u) => u.name), ["Bram", "Anouk", "Zoë"]);
});
