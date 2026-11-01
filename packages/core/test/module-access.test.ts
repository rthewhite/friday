import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { LiveConnectParameters } from "@google/genai";
import { PromptContext, ToolRegistry, type Tool } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { ModuleAccessStore } from "../src/storage/module-access.js";
import { ownedModules } from "../src/app.js";
import { resolveTools } from "../src/agents/definition.js";
import { ChatEngine } from "../src/chat/engine.js";
import { GeminiSession, type LiveConnect } from "../src/session.js";
import type { ModuleHost } from "../src/module-host.js";
import type { McpSource } from "../src/tools/mcp.js";
import type { RemoteHost } from "../src/remote/host.js";
import { setup } from "./conversation-fixtures.js";
import { fakeStream, text } from "./fake-stream.js";

const quiet = { log() {}, warn() {}, error() {} };
const raymond = { id: "u1", name: "Raymond" };
const sanne = { id: "u2", name: "Sanne" };
const kim = { id: "u3", name: "Kim" };
/** The household owner, who is always allowed. */
const owner = { id: "u0", name: "Owner" };

function store(db = fresh()) {
  return { db, access: new ModuleAccessStore(db, (id) => id === owner.id, () => new Date("2026-10-30T10:00:00Z")) };
}

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  return db;
}

const homeAssistant = { mode: "everyone" as const, users: [raymond.id], restricted: ["HomeAssistant__restart_ha", "HomeAssistant__*delete*"], known: [] };

test("no setting: every user gets the module and all its tools", () => {
  const { access } = store();
  assert.equal(access.allowsModule("sonos", sanne), true);
  assert.equal(access.allowsTool("sonos", "sonos_play", sanne), true);
  assert.equal(access.get("sonos"), undefined);
});

test("chosen users only: the module is the chosen users' and the owner's, nobody else's", () => {
  const { access } = store();
  access.set("sonos", { mode: "chosen", users: [raymond.id], restricted: [], known: ["sonos_play"] });
  assert.equal(access.allowsModule("sonos", sanne), false);
  assert.equal(access.allowsTool("sonos", "sonos_play", sanne), false);
  assert.equal(access.allowsModule("sonos", raymond), true);
  assert.equal(access.allowsTool("sonos", "sonos_play", raymond), true);
  assert.equal(access.allowsModule("sonos", owner), true, "the owner is always allowed");
  assert.equal(access.allowsTool("sonos", "sonos_play", undefined), true, "a call without a user is the owner's");
});

test("restricted tools: everyone gets the module, only the chosen users the tools matching a pattern", () => {
  const { access } = store();
  access.set("mcp:HomeAssistant", homeAssistant);
  const offered = (u: { id: string; name: string }) =>
    ["HomeAssistant__get_state", "HomeAssistant__call_service", "HomeAssistant__restart_ha", "HomeAssistant__delete_automation"].filter((t) => access.allowsTool("mcp:HomeAssistant", t, u));
  assert.deepEqual(offered(sanne), ["HomeAssistant__get_state", "HomeAssistant__call_service"]);
  assert.equal(offered(raymond).length, 4);
  assert.equal(offered(owner).length, 4);
  assert.equal(access.allowsModule("mcp:HomeAssistant", sanne), true);
});

test("another admin isn't implied, and a disabled user keeps their place", () => {
  const { access } = store();
  access.set("sonos", { mode: "chosen", users: [sanne.id], restricted: [], known: [] });
  assert.equal(access.allowsModule("sonos", kim), false, "Kim is an admin, but not chosen");
  // The store never looks at whether a user is disabled: their id stays in the list.
  assert.deepEqual(access.get("sonos")?.users, [sanne.id]);
});

test("the setting is stored, survives a new store, and clear goes back to the default", () => {
  const { db, access } = store();
  const saved = access.set("mcp:HomeAssistant", { ...homeAssistant, known: ["HomeAssistant__get_state"] });
  assert.deepEqual(saved, { ...homeAssistant, known: ["HomeAssistant__get_state"], updatedAt: "2026-10-30T10:00:00.000Z" });
  const again = store(db).access;
  assert.equal(again.allowsTool("mcp:HomeAssistant", "HomeAssistant__restart_ha", sanne), false);
  access.set("mcp:HomeAssistant", { mode: "everyone", users: [], restricted: [], known: [] });
  assert.equal(access.allowsTool("mcp:HomeAssistant", "HomeAssistant__restart_ha", sanne), true, "a write refreshes the in-memory copy");
  assert.equal(access.clear("mcp:HomeAssistant"), true);
  assert.equal(access.get("mcp:HomeAssistant"), undefined);
  assert.deepEqual({ ...db.prepare("SELECT COUNT(*) AS n FROM module_access_users").get() }, { n: 0 });
  assert.equal(access.clear("mcp:HomeAssistant"), false);
});

test("core and builtin have no access setting", () => {
  const { access } = store();
  for (const id of ["core", "builtin"]) assert.throws(() => access.set(id, { mode: "chosen", users: [], restricted: [], known: [] }), /has no access setting/);
  assert.equal(access.allowsTool("core", "set_timer", sanne), true);
});

test("listing ids map to owner tags: in-process and MCP ids as they are, a remote id under remote:", () => {
  const registry = new ToolRegistry(quiet);
  const host = { loaded: () => [{ id: "sonos", label: "Sonos", status: "loaded", tools: [], ui: true }] } as unknown as ModuleHost;
  const mcp = { servers: () => [{ name: "home", status: "loaded", tools: [] }] } as unknown as McpSource;
  const remote = { connected: () => [{ id: "simracing", label: "Sim", status: "connected", tools: [], connectedAt: "t" }] } as unknown as RemoteHost;
  assert.deepEqual(ownedModules({ registry, host, mcp, remote }).map((m) => [m.entry.id, m.owner]), [["sonos", "sonos"], ["mcp:home", "mcp:home"], ["simracing", "remote:simracing"]]);
});

/** A registry and prompt context wired as server.ts wires them, with Home Assistant restricted and Sonos chosen. */
function household() {
  const { access } = store();
  access.set("mcp:HomeAssistant", { ...homeAssistant, users: [raymond.id] });
  access.set("sonos", { mode: "chosen", users: [raymond.id], restricted: [], known: [] });
  const r = new ToolRegistry(quiet);
  r.setOwnerCheck((u) => u?.id === owner.id);
  r.setAccessCheck((o, t, u) => access.allowsTool(o, t, u));
  const tool = (name: string): Tool => ({ name, description: "", handler: () => ({ ok: true }) });
  for (const n of ["HomeAssistant__get_state", "HomeAssistant__restart_ha"]) r.add("mcp:HomeAssistant", tool(n));
  r.add("sonos", tool("sonos_play"));
  r.add("builtin", tool("get_current_time"));
  const prompts = new PromptContext({ log: quiet });
  prompts.setAccessCheck((o, u) => access.allowsModule(o, u));
  prompts.forOwner("sonos").addContext(() => "## Sonos");
  prompts.forOwner("builtin").addContext(() => "## Builtin");
  return { r, prompts, access };
}

test("a member's chat turn leaves out a chosen module's tools and the restricted ones; the chosen user gets them", async () => {
  const { r } = household();
  const s = setup();
  const f = fakeStream({ chunks: [text("ok")] });
  const engine = new ChatEngine({ store: s.store, registry: r, llm: f.llm, model: "m", system: () => "P", toolTimeoutMs: 1000, log: quiet });
  for (const user of [sanne, raymond]) {
    const turn = engine.begin({ text: "restart home assistant" }, { ...user, role: "member" });
    assert.ok(turn.ok);
    await turn.turn.run(() => {});
  }
  assert.deepEqual(
    f.requests.map((req) => (req.tools ?? []).map((d) => d.name)),
    [["HomeAssistant__get_state", "get_current_time"], ["HomeAssistant__get_state", "HomeAssistant__restart_ha", "sonos_play", "get_current_time"]],
  );
});

function fakeLive() {
  const params: LiveConnectParameters[] = [];
  const connect: LiveConnect = async (p) => {
    params.push(p);
    return { sendRealtimeInput() {}, sendClientContent() {}, sendToolResponse() {}, close() {} };
  };
  return { connect, params };
}

const toolNames = (p: LiveConnectParameters): string[] => (p.config!.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((d) => d.name);

test("a member's Talk session leaves them out; a voice device, acting for the owner, gets everything", async () => {
  const { r } = household();
  const live = fakeLive();
  const talk = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => "k", user: sanne });
  const kitchen = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => "k", device: "friday-kitchen", user: owner });
  for (const s of [talk, kitchen]) await s.open();
  assert.deepEqual(live.params.map(toolNames), [
    ["HomeAssistant__get_state", "get_current_time"],
    ["HomeAssistant__get_state", "HomeAssistant__restart_ha", "sonos_play", "get_current_time"],
  ]);
  for (const s of [talk, kitchen]) s.close();
});

test("an agent of a member doesn't get a restricted tool its pattern matches", () => {
  const { r } = household();
  const resolved = resolveTools({ tools: [{ pattern: "HomeAssistant__*", mode: "auto" }] }, r, sanne);
  assert.deepEqual([...resolved.tools.keys()], ["HomeAssistant__get_state"]);
  assert.deepEqual([...resolveTools({ tools: [{ pattern: "HomeAssistant__*", mode: "auto" }] }, r, raymond).tools.keys()], ["HomeAssistant__get_state", "HomeAssistant__restart_ha"]);
});

test("prompt context: a chosen module's text is left out of a member's prompt and kept in the owner's", () => {
  const { prompts } = household();
  assert.equal(prompts.render("chat", sanne), "## Builtin");
  assert.equal(prompts.render("chat", owner), "## Sonos\n\n## Builtin");
  assert.equal(prompts.render("voice"), "## Sonos\n\n## Builtin", "a prompt without a user is the owner's");
});

test("a remote module that disconnects and connects again keeps its access: it is keyed by the owner tag", () => {
  const { r, access } = household();
  access.set("remote:simracing", { mode: "chosen", users: [raymond.id], restricted: [], known: [] });
  const add = () => r.add("remote:simracing", { name: "simracing__lap_times", description: "", handler: () => ({}) });
  add();
  r.removeOwner("remote:simracing");
  add();
  assert.equal(r.declarations("chat", sanne).some((d) => d.name === "simracing__lap_times"), false);
  assert.equal(r.declarations("chat", raymond).some((d) => d.name === "simracing__lap_times"), true);
  assert.equal(r.declarations("chat", owner).some((d) => d.name === "simracing__lap_times"), true);
});

test("a change applies to the next call, and an open session's call to a newly restricted tool is refused", async () => {
  const { r, access } = household();
  access.clear("mcp:HomeAssistant");
  const live = fakeLive();
  let restarted = 0;
  r.remove("HomeAssistant__restart_ha");
  r.add("mcp:HomeAssistant", { name: "HomeAssistant__restart_ha", description: "", handler: () => (restarted++, { ok: true }) });
  const talk = new GeminiSession(() => {}, r, { connect: live.connect, log: quiet, geminiKey: () => "k", user: sanne });
  await talk.open();
  assert.ok(toolNames(live.params[0]).includes("HomeAssistant__restart_ha"), "offered before the change");
  access.set("mcp:HomeAssistant", homeAssistant);
  const call = await r.callTool("HomeAssistant__restart_ha", {}, { channel: "voice", user: sanne });
  assert.deepEqual(call.result, { error: "HomeAssistant__restart_ha isn't available to you" });
  assert.equal(restarted, 0, "Home Assistant is not restarted");
  assert.equal(r.declarations("chat", sanne).some((d) => d.name === "HomeAssistant__restart_ha"), false, "the next chat turn no longer offers it");
  talk.close();
});
