import { test } from "node:test";
import assert from "node:assert/strict";
import { accessBody, accessLabel, addPattern, draftOf, isNewTool, isRestricted, matchesPattern, patternsOf, removePattern, toggleTool, toggleUser, type ModuleAccess } from "../src/lib/access.ts";

const ha: ModuleAccess = {
  mode: "everyone",
  users: [{ id: "u0", name: "Owner" }, { id: "u1", name: "Raymond" }],
  restricted: ["HomeAssistant__restart_ha", "HomeAssistant__*delete*"],
  knownTools: ["HomeAssistant__get_state", "HomeAssistant__restart_ha"],
};

test("patterns match whole names, * matching anything and every other character itself", () => {
  assert.equal(matchesPattern("HomeAssistant__*delete*", "HomeAssistant__delete_automation"), true);
  assert.equal(matchesPattern("HomeAssistant__restart_ha", "HomeAssistant__restart_ha"), true);
  assert.equal(matchesPattern("HomeAssistant__restart", "HomeAssistant__restart_ha"), false, "anchored");
  assert.equal(matchesPattern("a.b", "axb"), false, "a dot is a dot");
  assert.equal(isRestricted("HomeAssistant__delete_area", ha.restricted), true);
  assert.equal(isRestricted("HomeAssistant__get_state", ha.restricted), false);
});

test("a tool missing from knownTools is new; nothing is new while the access is the default", () => {
  assert.equal(isNewTool("HomeAssistant__wipe_history", ha), true);
  assert.equal(isNewTool("HomeAssistant__get_state", ha), false);
  assert.equal(isNewTool("HomeAssistant__wipe_history", { mode: "everyone", users: [], restricted: [] }), false);
});

test("the row label says who may use the module, and nothing for the default", () => {
  assert.equal(accessLabel({ ...ha, mode: "chosen" }), "Chosen users");
  assert.equal(accessLabel(ha), "Some tools restricted");
  assert.equal(accessLabel({ mode: "everyone", users: [{ id: "u1", name: "R" }], restricted: [] }), undefined);
  assert.equal(accessLabel(undefined), undefined);
});

test("the draft leaves the owner out, ticks tools by name and keeps patterns apart", () => {
  let d = draftOf(ha, "u0");
  assert.deepEqual(d, { mode: "everyone", users: ["u1"], restricted: ["HomeAssistant__restart_ha", "HomeAssistant__*delete*"] });
  const tools = ["HomeAssistant__get_state", "HomeAssistant__restart_ha"];
  assert.deepEqual(patternsOf(d, tools), ["HomeAssistant__*delete*"]);
  d = toggleTool(d, "HomeAssistant__restart_ha", false);
  d = toggleTool(d, "HomeAssistant__get_state", true);
  d = addPattern(d, "  *save_* ");
  d = addPattern(d, "*save_*");
  d = addPattern(d, "   ");
  d = removePattern(d, "HomeAssistant__*delete*");
  d = toggleUser(toggleUser(d, "u2", true), "u1", false);
  assert.deepEqual(d, { mode: "everyone", users: ["u2"], restricted: ["HomeAssistant__get_state", "*save_*"] });
});

test("the PUT body drops the restricted tools for chosen users, where nobody else gets the module", () => {
  assert.deepEqual(accessBody({ mode: "everyone", users: ["u1"], restricted: ["x"] }), { mode: "everyone", users: ["u1"], restricted: ["x"] });
  assert.deepEqual(accessBody({ mode: "chosen", users: ["u1"], restricted: ["x"] }), { mode: "chosen", users: ["u1"], restricted: [] });
});
