import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import ModulesPage from "../../src/pages/settings/ModulesPage.vue";
import ModuleGate from "../../src/shell/ModuleGate.vue";
import { me } from "../../src/composables/useSession.js";
import { refreshModules } from "../../src/composables/useModules.js";
import { button, fakeApi, flushPromises, routerAt, type ApiRoutes } from "./helpers.js";

const api = vi.hoisted(() => ({ impl: (async () => undefined) as (path: string, init?: object) => Promise<unknown> }));
vi.mock("../../src/composables/useApi.js", () => ({ api: (path: string, init?: object) => api.impl(path, init) }));

type Row = { id: string; label: string; status: string; tools: string[]; ui?: boolean; error?: string; connectedAt?: string };
const listing = (): Row[] => [
  { id: "core", label: "Core", status: "loaded", tools: ["set_timer"], ui: false },
  { id: "sonos", label: "Sonos", status: "loaded", tools: ["sonos_play"], ui: false },
  { id: "media", label: "Media", status: "disabled", tools: [], ui: true },
  { id: "travel", label: "Travel", status: "disabled", tools: [], ui: false },
  { id: "mcp:home", label: "home", status: "loaded", tools: ["turn_on"] },
  { id: "simracing", label: "Sim racing", status: "connected", tools: ["simracing__lap"], connectedAt: "2026-10-29T09:00:00Z" },
];

let modules = listing();
beforeEach(() => {
  modules = listing();
  // refreshModules reads the listing with fetch; the switch goes through api().
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => structuredClone(modules) }));
});
afterEach(() => vi.unstubAllGlobals());

async function page(routes: ApiRoutes) {
  const fake = fakeApi(routes);
  api.impl = fake.api;
  const router = await routerAt("/settings/modules");
  const w = mount(ModulesPage, { global: { plugins: [router], stubs: { teleport: true } } });
  await flushPromises();
  return { w, calls: fake.calls };
}

const row = (w: VueWrapper, label: string) => {
  const r = w.findAll("tr").find((x) => x.text().includes(label));
  if (!r) throw new Error(`no row ${label}`);
  return r;
};
const toggle = (w: VueWrapper, label: string) => row(w, label).find("input[type=checkbox]");
const puts = (calls: { method: string }[]) => calls.filter((c) => c.method === "PUT");

describe("ModulesPage", () => {
  it("only in-process modules have a switch, on unless disabled", async () => {
    const { w } = await page({});
    expect((toggle(w, "Sonos").element as HTMLInputElement).checked).toBe(true);
    expect((toggle(w, "Media").element as HTMLInputElement).checked).toBe(false);
    for (const label of ["Core", "home", "Sim racing"]) expect(toggle(w, label).exists()).toBe(false);
  });

  it("turning a module off asks first; cancel sends nothing and leaves the switch on", async () => {
    const { w, calls } = await page({});
    await toggle(w, "Sonos").setValue(false);
    await flushPromises();
    expect(w.find("[role=dialog]").text()).toContain("Turn off Sonos?");
    expect((toggle(w, "Sonos").element as HTMLInputElement).checked).toBe(true);
    await button(w, "Cancel").trigger("click");
    await flushPromises();
    expect(w.find("[role=dialog]").text()).not.toContain("Turn off Sonos?");
    expect(puts(calls)).toEqual([]);
    expect((toggle(w, "Sonos").element as HTMLInputElement).checked).toBe(true);
  });

  it("confirming turns it off: the row shows disabled, without tools or Reload", async () => {
    const { w, calls } = await page({ "PUT /api/modules/sonos/enabled": { id: "sonos", label: "Sonos", status: "disabled", tools: [], ui: false } });
    await toggle(w, "Sonos").setValue(false);
    await flushPromises();
    await button(w, "Turn off").trigger("click");
    await flushPromises();
    expect(puts(calls)).toEqual([{ path: "/api/modules/sonos/enabled", method: "PUT", json: { enabled: false } }]);
    expect((toggle(w, "Sonos").element as HTMLInputElement).checked).toBe(false);
    expect(row(w, "Sonos").findAll("button").map((b) => b.text())).not.toContain("Reload");
    expect(w.find("[role=dialog]").text()).toContain("disabled");
  });

  it("turning a module on needs no confirmation; a failed start shows failed with the error", async () => {
    const failed = { id: "media", label: "Media", status: "failed", tools: [], ui: true, error: "module media: missing required config JELLYFIN_URL" };
    const { w, calls } = await page({ "PUT /api/modules/media/enabled": failed });
    await toggle(w, "Media").setValue(true);
    await flushPromises();
    expect(puts(calls)).toEqual([{ path: "/api/modules/media/enabled", method: "PUT", json: { enabled: true } }]);
    expect((toggle(w, "Media").element as HTMLInputElement).checked).toBe(true);
    await row(w, "Media").trigger("click");
    await flushPromises();
    expect(w.find("[role=dialog]").text()).toContain("JELLYFIN_URL");
  });

  it("a refused request leaves the switch where it was and shows the error", async () => {
    const { w } = await page({ "PUT /api/modules/travel/enabled": () => { throw new Error("forbidden"); } });
    await toggle(w, "Travel").setValue(true);
    await flushPromises();
    expect((toggle(w, "Travel").element as HTMLInputElement).checked).toBe(false);
    expect(w.text()).toContain("forbidden");
  });

  it("each switch stays locked until its own request answers", async () => {
    let answerTravel!: (v: unknown) => void;
    let answerMedia!: (v: unknown) => void;
    const { w } = await page({
      "PUT /api/modules/travel/enabled": () => new Promise((r) => (answerTravel = r)),
      "PUT /api/modules/media/enabled": () => new Promise((r) => (answerMedia = r)),
    });
    await toggle(w, "Travel").setValue(true);
    await toggle(w, "Media").setValue(true);
    await flushPromises();
    expect(toggle(w, "Travel").attributes("disabled")).toBeDefined();
    expect(toggle(w, "Media").attributes("disabled")).toBeDefined();
    answerTravel({ id: "travel", label: "Travel", status: "loaded", tools: ["get_travel_time"], ui: false });
    await flushPromises();
    expect(toggle(w, "Travel").attributes("disabled")).toBeUndefined();
    expect(toggle(w, "Media").attributes("disabled")).toBeDefined();
    answerMedia({ id: "media", label: "Media", status: "loaded", tools: ["search_library"], ui: true });
    await flushPromises();
    expect(toggle(w, "Media").attributes("disabled")).toBeUndefined();
  });
});

describe("ModuleGate for a disabled module", () => {
  async function gate(role: "admin" | "member") {
    me.value = { id: "u", name: "U", email: null, role, owner: false, authEnabled: true };
    api.impl = fakeApi({}).api;
    await refreshModules(); // the list is shared; earlier tests left their switches in it
    const router = await routerAt("/m/media");
    const w = mount(ModuleGate, { props: { id: "media" }, global: { plugins: [router] } });
    await flushPromises();
    return w;
  }
  afterEach(() => { me.value = undefined; });

  it("says it is turned off and gives an admin the link to the Modules page", async () => {
    const w = await gate("admin");
    expect(w.text()).toContain("is turned off for this Friday");
    expect(w.text()).not.toContain("FRIDAY_MODULES");
    expect(w.find('a[href="/settings/modules"]').exists()).toBe(true);
  });

  it("gives a member no link to a page they can't open", async () => {
    const w = await gate("member");
    expect(w.text()).toContain("is turned off for this Friday");
    expect(w.find('a[href="/settings/modules"]').exists()).toBe(false);
  });
});

describe("ModulesPage access", () => {
  const ha = {
    id: "mcp:HomeAssistant",
    label: "HomeAssistant",
    status: "loaded",
    tools: ["HomeAssistant__get_state", "HomeAssistant__restart_ha", "HomeAssistant__delete_automation", "HomeAssistant__wipe_history"],
    ui: false,
    available: true,
    access: { mode: "everyone", users: [], restricted: [], knownTools: ["HomeAssistant__get_state", "HomeAssistant__restart_ha", "HomeAssistant__delete_automation"] },
  };
  const users = {
    users: [
      { id: "u0", name: "Owner", email: null, role: "admin", owner: true, disabled: false, firstLoginAt: "t", lastLoginAt: "t" },
      { id: "u1", name: "Raymond", email: null, role: "admin", owner: false, disabled: false, firstLoginAt: "t", lastLoginAt: "t" },
      { id: "u2", name: "Sanne", email: null, role: "member", owner: false, disabled: true, firstLoginAt: "t", lastLoginAt: "t" },
    ],
  };
  const PATH = "/api/modules/mcp%3AHomeAssistant/access";
  const drawer = (w: VueWrapper) => w.find("[role=dialog]");
  const box = (w: VueWrapper, attr: string, value: string) => drawer(w).find(`label[data-${attr}="${value}"] input`);

  async function opened(routes: ApiRoutes) {
    modules = [...listing(), structuredClone(ha)];
    const p = await page({ "GET /api/users": users, ...routes });
    await row(p.w, "HomeAssistant").trigger("click");
    await flushPromises();
    return p;
  }

  it("restricts tools for everyone but the chosen users, saves them, and labels the row", async () => {
    const saved = { ...ha, access: { mode: "everyone", users: [{ id: "u1", name: "Raymond" }], restricted: ["HomeAssistant__restart_ha", "HomeAssistant__*delete*"], knownTools: ha.tools } };
    const { w, calls } = await opened({ [`PUT ${PATH}`]: saved });
    expect(drawer(w).text()).toContain("Access");
    expect(row(w, "HomeAssistant").text()).not.toContain("Some tools restricted");
    await box(w, "user", "u1").setValue(true);
    await box(w, "tool", "HomeAssistant__restart_ha").setValue(true);
    await drawer(w).find("input[aria-label=Pattern]").setValue("HomeAssistant__*delete*");
    await drawer(w).find("form").trigger("submit");
    await flushPromises();
    expect((box(w, "tool", "HomeAssistant__delete_automation").element as HTMLInputElement).checked).toBe(true);
    expect(drawer(w).find('label[data-tool="HomeAssistant__delete_automation"]').text()).toContain("(by pattern)");
    await button(w, "Save").trigger("click");
    await flushPromises();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { path: PATH, method: "PUT", json: { mode: "everyone", users: ["u1"], restricted: ["HomeAssistant__restart_ha", "HomeAssistant__*delete*"] } },
    ]);
    expect(row(w, "HomeAssistant").text()).toContain("Some tools restricted");
  });

  it("shows the owner as always included and disabled users as disabled, and marks tools added since the last save", async () => {
    const { w } = await opened({});
    const owner = box(w, "user", "u0").element as HTMLInputElement;
    expect(owner.checked && owner.disabled).toBe(true);
    expect(drawer(w).find('label[data-user="u0"]').text()).toContain("always included");
    expect(drawer(w).find('label[data-user="u2"]').text()).toContain("(disabled)");
    expect(drawer(w).find('label[data-tool="HomeAssistant__wipe_history"]').text()).toContain("new");
    expect(drawer(w).find('label[data-tool="HomeAssistant__get_state"]').text()).not.toContain("new");
  });

  it("chosen users hide the restricted tools; Reset to everyone sends DELETE; a failed save keeps the edits", async () => {
    const { w, calls } = await opened({
      [`PUT ${PATH}`]: () => { throw new Error('unknown user "u1"'); },
      [`DELETE ${PATH}`]: { ...ha, access: { mode: "everyone", users: [], restricted: [] } },
    });
    await drawer(w).find('input[type=radio][value="chosen"]').setValue(true);
    await box(w, "user", "u1").setValue(true);
    expect(drawer(w).text()).not.toContain("Restricted tools");
    await button(w, "Save").trigger("click");
    await flushPromises();
    expect(drawer(w).text()).toContain('unknown user "u1"');
    expect((box(w, "user", "u1").element as HTMLInputElement).checked).toBe(true);
    expect((drawer(w).find('input[type=radio][value="chosen"]').element as HTMLInputElement).checked).toBe(true);
    await button(w, "Reset to everyone").trigger("click");
    await flushPromises();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ path: PATH, method: "DELETE" }]);
    expect((drawer(w).find('input[type=radio][value="everyone"]').element as HTMLInputElement).checked).toBe(true);
  });

  it("switching the module off in the drawer keeps unsaved access edits", async () => {
    const access = { mode: "everyone", users: [], restricted: [], knownTools: ["sonos_play"] };
    modules = listing().map((m) => (m.id === "sonos" ? { ...m, available: true, access } : m));
    const fake = fakeApi({ "GET /api/users": users, "PUT /api/modules/sonos/enabled": { id: "sonos", label: "Sonos", status: "disabled", tools: [], ui: false, available: true, access } });
    api.impl = fake.api;
    // The real Teleport, as in the browser: the stubbed one renders the drawer afresh on every update of the page.
    const w = mount(ModulesPage, { attachTo: document.body, global: { plugins: [await routerAt("/settings/modules")] } });
    try {
      await flushPromises();
      await row(w, "Sonos").trigger("click");
      await flushPromises();
      const dialog = () => document.querySelector("[role=dialog]")!;
      const input = (sel: string) => dialog().querySelector(sel) as HTMLInputElement;
      const tick = async (sel: string, on: boolean) => {
        input(sel).checked = on;
        input(sel).dispatchEvent(new Event("change"));
        await flushPromises();
      };
      await tick('label[data-user="u1"] input', true);
      await tick('label[data-tool="sonos_play"] input', true);
      await tick("input[type=checkbox]", false); // the drawer's Enabled switch, which asks first
      [...dialog().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Turn off")!.click();
      await flushPromises();
      expect(dialog().textContent).toContain("disabled");
      expect(fake.calls.filter((c) => c.path === "/api/users").length, "the section isn't mounted again").toBe(1);
      expect(input('label[data-user="u1"] input').checked).toBe(true);
      expect(input('label[data-tool="sonos_play"] input').checked, "the known tool stays listed and ticked").toBe(true);
    } finally {
      w.unmount();
    }
  });

  it("core and builtin have no Access section", async () => {
    const { w } = await page({ "GET /api/users": users });
    await row(w, "Core").trigger("click");
    await flushPromises();
    expect(drawer(w).find("input[type=radio]").exists()).toBe(false);
    expect(drawer(w).text()).not.toContain("Reset to everyone");
  });

  it("the row says Chosen users when only chosen users may use the module", async () => {
    modules = [...listing(), { ...structuredClone(ha), access: { mode: "chosen", users: [], restricted: [], knownTools: [] } }];
    const { w } = await page({});
    expect(row(w, "HomeAssistant").text()).toContain("Chosen users");
  });
});

describe("ModuleGate for a module the user may not use", () => {
  afterEach(() => { me.value = undefined; });

  it("tells a member it isn't available to them, without saying who may use it", async () => {
    me.value = { id: "u2", name: "Sanne", email: null, role: "member", owner: false, authEnabled: true };
    modules = listing().filter((m) => m.id !== "media"); // members aren't sent the modules they may not use
    api.impl = fakeApi({}).api;
    await refreshModules();
    const router = await routerAt("/m/media");
    const w = mount(ModuleGate, { props: { id: "media" }, global: { plugins: [router], provide: { moduleUis: [{ id: "media", nav: { label: "Media" } }] } } });
    await flushPromises();
    expect(w.text()).toContain("isn't available to you");
    expect(w.text()).toContain("Ask an admin");
    expect(w.text()).not.toContain("not part of this deployment");
  });
});
