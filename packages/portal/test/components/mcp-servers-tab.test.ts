import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import McpServersTab from "../../src/pages/settings/McpServersTab.vue";
import { button, fakeApi, field, flushPromises, routerAt, type ApiRoutes } from "./helpers.js";

const api = vi.hoisted(() => ({ impl: (async () => undefined) as (path: string, init?: object) => Promise<unknown> }));
vi.mock("../../src/composables/useApi.js", () => ({ api: (path: string, init?: object) => api.impl(path, init) }));
vi.mock("../../src/composables/useModules.js", () => ({ refreshModules: async () => {} }));

const home = {
  name: "home",
  enabled: true,
  url: "https://ha.example/mcp",
  headers: [{ name: "Authorization", secret: true }],
  status: "loaded",
  tools: ["turn_on"],
  updatedAt: "2026-10-27T10:00:00Z",
};

async function tab(routes: ApiRoutes, path = "/settings/configuration?tab=mcp&server=home") {
  const fake = fakeApi({ "GET /api/mcp/servers": { secretsEnabled: true, servers: [home] }, ...routes });
  api.impl = fake.api;
  const router = await routerAt(path);
  const w = mount(McpServersTab, { global: { plugins: [router], stubs: { teleport: true } } });
  await flushPromises();
  return { w, router, calls: fake.calls };
}

describe("McpServersTab", () => {
  it("?server= opens that server's drawer, with its stored secret kept out of the form", async () => {
    const { w } = await tab({});
    expect(w.find("[role=dialog]").exists()).toBe(true);
    expect(field(w, "URL").element.value).toBe("https://ha.example/mcp");
    const secret = w.findAll("input").find((i) => i.attributes("placeholder")?.includes("stored, leave blank to keep"));
    expect(secret?.element.value).toBe("");
  });

  it("a save the server refuses keeps the drawer open with the error, and the form as typed", async () => {
    const { w, calls } = await tab({ "PUT /api/mcp/servers/home": () => { throw new Error("url must be http(s)"); } });
    await field(w, "URL").setValue("ftp://ha.example/mcp");
    await button(w, "Save").trigger("click");
    await flushPromises();
    expect(calls.find((c) => c.method === "PUT")?.json).toMatchObject({ url: "ftp://ha.example/mcp", headers: [{ name: "Authorization", secret: true }] });
    expect(w.find("[role=dialog]").exists()).toBe(true);
    expect(w.find("[role=dialog]").text()).toContain("url must be http(s)");
    expect(field(w, "URL").element.value).toBe("ftp://ha.example/mcp");
    expect(calls.filter((c) => c.path === "/api/mcp/servers" && c.method === "GET")).toHaveLength(1);
  });

  it("a saved server keeps the drawer open on it with its new status", async () => {
    const { w } = await tab({ "PUT /api/mcp/servers/home": { ...home, status: "failed", error: "connection refused" } });
    await button(w, "Save").trigger("click");
    await flushPromises();
    expect(w.find("[role=dialog]").text()).toContain("home saved, but it failed to connect");
  });
});
