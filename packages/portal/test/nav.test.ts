import { test } from "node:test";
import assert from "node:assert/strict";
import { navItems } from "../src/lib/nav.js";
import { isAdminPath } from "../src/lib/auth.js";

const uis = [
  { id: "media", nav: { label: "Media", icon: "film" } },
  { id: "brain", nav: { label: "Brain", order: 10 } },
];
const groupOf = (items: ReturnType<typeof navItems>, group: string) => items.filter((i) => i.group === group).map((i) => i.label);

test("an admin sees the module UIs under Modules and the System pages starting with Modules", () => {
  const items = navItems(uis, (id) => id === "media", "admin");
  assert.deepEqual(groupOf(items, "Assistant"), ["Talk", "Chat", "Conversations", "Agents"]);
  assert.deepEqual(groupOf(items, "Modules"), ["Media"], "only usable module UIs, and no Modules page here");
  assert.deepEqual(groupOf(items, "System"), ["Modules", "Configuration", "Connections", "Voice devices", "Alerts", "Remote modules", "Jobs", "Users"]);
  assert.equal(items.find((i) => i.label === "Modules")?.to, "/settings/modules");
  assert.ok(isAdminPath("/settings/modules"), "a member opening it gets the admin-only page");
});

test("module UIs are ordered by nav.order, then label", () => {
  assert.deepEqual(groupOf(navItems(uis, () => true, "admin"), "Modules"), ["Brain", "Media"]);
});

test("a member sees Assistant and the module UIs, and no System section", () => {
  const items = navItems(uis, () => true, "member");
  assert.deepEqual(groupOf(items, "Modules"), ["Brain", "Media"]);
  assert.deepEqual(groupOf(items, "System"), []);
});

test("without a usable module UI there are no items in the Modules section", () => {
  assert.deepEqual(groupOf(navItems(uis, () => false, "admin"), "Modules"), []);
  assert.deepEqual(groupOf(navItems(uis, () => false, "member"), "Modules"), []);
});
