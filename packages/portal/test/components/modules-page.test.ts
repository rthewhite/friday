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
