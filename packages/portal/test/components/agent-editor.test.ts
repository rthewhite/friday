import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AgentEditor from "../../src/pages/AgentEditor.vue";
import { button, fakeApi, field, flushPromises, routerAt, type ApiRoutes } from "./helpers.js";

const api = vi.hoisted(() => ({ impl: (async () => undefined) as (path: string, init?: object) => Promise<unknown> }));
vi.mock("../../src/composables/useApi.js", () => ({ api: (path: string, init?: object) => api.impl(path, init) }));

const created = { name: "weekly-review", description: "Sums up my week", instructions: "Read my calendar.", enabled: true, startable: false, tools: [], budgets: { maxToolCalls: 30, maxTokens: 200_000, maxMinutes: 10 }, unmatched: [], running: false };

async function editor(routes: ApiRoutes) {
  const fake = fakeApi({ "GET /api/agents/tools": { tools: [{ name: "calendar_list_events", owner: "calendar", description: "" }] }, ...routes });
  api.impl = fake.api;
  const router = await routerAt("/agents/new");
  const w = mount(AgentEditor, { props: { name: "new" }, global: { plugins: [router], stubs: { teleport: true } } });
  await flushPromises();
  return { w, router, calls: fake.calls };
}

async function fillNew(w: Awaited<ReturnType<typeof editor>>["w"]) {
  await field(w, "Name").setValue(" weekly-review ");
  await field(w, "Description").setValue("Sums up my week");
  await w.find("textarea").setValue("Read my calendar.");
}

describe("AgentEditor", () => {
  it("creates a new agent with the form's body and opens its page", async () => {
    const { w, router, calls } = await editor({ "POST /api/agents": created });
    expect(button(w, "Create").attributes("disabled")).toBeDefined();
    await fillNew(w);
    expect(button(w, "Create").attributes("disabled")).toBeUndefined();
    await button(w, "Create").trigger("click");
    await flushPromises();
    expect(calls.find((c) => c.method === "POST")).toEqual({
      path: "/api/agents",
      method: "POST",
      json: { name: "weekly-review", description: "Sums up my week", instructions: "Read my calendar.", schedule: null, enabled: true, startable: false, tools: [], budgets: { maxToolCalls: 30, maxTokens: 200_000, maxMinutes: 10 } },
    });
    expect(router.currentRoute.value.path).toBe("/agents/weekly-review");
    // The new page's editor reads the notice from the history entry (memory history here).
    expect(router.options.history.state.notice).toBe("Saved");
  });

  it("shows the server's error when it refuses the agent, and stays on the new-agent page", async () => {
    const { w, router } = await editor({ "POST /api/agents": () => { throw new Error("an agent named weekly-review already exists"); } });
    await fillNew(w);
    await button(w, "Create").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("an agent named weekly-review already exists");
    expect(router.currentRoute.value.path).toBe("/agents/new");
    expect(button(w, "Create").attributes("disabled")).toBeUndefined();
  });
});
