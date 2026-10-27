import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ConnectionsPage from "../../src/pages/settings/ConnectionsPage.vue";
import { button, fakeApi, field, flushPromises, routerAt, type ApiCall, type ApiRoutes } from "./helpers.js";

const api = vi.hoisted(() => ({ impl: (async () => undefined) as (path: string, init?: object) => Promise<unknown> }));
vi.mock("../../src/composables/useApi.js", () => ({ api: (path: string, init?: object) => api.impl(path, init) }));

const spotify = {
  provider: "spotify",
  name: "Spotify",
  configured: true,
  generic: false,
  clientId: "client-1",
  hasClientSecret: true,
  extraScopes: [],
  requestedScopes: ["playlist-read-private"],
  missingScopes: [],
  requesters: [{ module: "spotify", scopes: ["playlist-read-private"], granted: true }],
  state: "connected",
  redirectUri: "https://friday.example/api/oauth/spotify/callback",
};

async function page(routes: ApiRoutes) {
  const fake = fakeApi({
    "GET /api/oauth/connections": { secretsEnabled: true, redirectBase: "https://friday.example", connections: [spotify] },
    "GET /api/oauth/providers": [{ id: "spotify", name: "Spotify", pkce: true, refresh: true }],
    "PUT /api/oauth/connections/spotify": (c: ApiCall) => ({ ...spotify, clientId: (c.json as { clientId: string }).clientId }),
    ...routes,
  });
  api.impl = fake.api;
  const router = await routerAt("/settings/connections?provider=spotify");
  const w = mount(ConnectionsPage, { global: { plugins: [router], stubs: { teleport: true } } });
  await flushPromises();
  return { w, calls: fake.calls };
}

const secretInput = (w: Awaited<ReturnType<typeof page>>["w"]) => field(w, "Client secret");

describe("ConnectionsPage", () => {
  it("a stored client secret is never shown, and the redirect URI to register uses the public base", async () => {
    const { w } = await page({});
    expect(secretInput(w).element.value).toBe("");
    expect(secretInput(w).attributes("placeholder")).toBe("•••••• stored, leave blank to keep");
    expect(w.find("[role=dialog]").text()).toContain("https://friday.example/api/oauth/spotify/callback");
    expect(button(w, "Save").attributes("disabled"), "nothing changed yet").toBeDefined();
  });

  it("changing only the client id saves without a client secret, so the stored one is kept", async () => {
    const { w, calls } = await page({});
    await field(w, "Client id").setValue("client-2");
    await button(w, "Save").trigger("click");
    await flushPromises();
    expect(calls.find((c) => c.method === "PUT")).toEqual({ path: "/api/oauth/connections/spotify", method: "PUT", json: { clientId: "client-2", extraScopes: [] } });
    expect(w.find("[role=dialog]").text()).toContain("Spotify saved");
  });

  it("a typed client secret is sent", async () => {
    const { w, calls } = await page({});
    await secretInput(w).setValue("new-s3cret");
    await button(w, "Save").trigger("click");
    await flushPromises();
    expect(calls.find((c) => c.method === "PUT")?.json).toEqual({ clientId: "client-1", clientSecret: "new-s3cret", extraScopes: [] });
  });
});
