import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import ConversationsPage from "../../src/pages/ConversationsPage.vue";
import { fakeApi, flushPromises, routerAt } from "./helpers.js";

const api = vi.hoisted(() => ({ impl: (async () => undefined) as (path: string, init?: object) => Promise<unknown> }));
vi.mock("../../src/composables/useApi.js", () => ({ api: (path: string, init?: object) => api.impl(path, init) }));

const summary = {
  id: "c1", channel: "voice", device: "friday-kitchen", startedAt: "2026-11-06T21:35:50Z", lastActivityAt: "2026-11-06T21:36:10Z",
  endedAt: null, endReason: null, quietAt: null, state: "active", entryCount: 4, preview: "Turn on the lights in the living room please",
};

let w: VueWrapper;
afterEach(() => w?.unmount());

async function page() {
  api.impl = fakeApi({
    "GET /api/conversations": { conversations: [summary], next: null },
    "GET /api/devices": { devices: [], pending: [] },
  }).api;
  w = mount(ConversationsPage, { global: { plugins: [await routerAt("/conversations")], stubs: { teleport: true } } });
  await flushPromises();
}

describe("Conversations page on a phone", () => {
  it("leads with the preview, over two lines, with the state, start and channel below it", async () => {
    await page();
    const cells = w.findAll("tbody td");
    // The state and start columns are for md and up; on phones they move into the preview cell.
    const [state, started] = cells;
    expect(state!.classes()).toEqual(expect.arrayContaining(["hidden", "md:table-cell"]));
    expect(started!.classes()).toEqual(expect.arrayContaining(["hidden", "md:table-cell"]));
    const preview = cells.find((c) => c.text().includes("Turn on the lights"))!;
    expect(preview.classes()).not.toContain("hidden");
    expect(preview.get("span").classes()).toEqual(expect.arrayContaining(["line-clamp-1", "max-md:line-clamp-2"]));
    const meta = preview.get("[data-phone-meta]");
    expect(meta.classes()).toContain("md:hidden");
    expect(meta.text()).toContain("06-11-2026");
    expect(meta.text()).toContain("voice");
    expect(meta.find('[aria-label="active"]').exists()).toBe(true);
  });

  it("keeps the desktop columns: state, start, channel and preview", async () => {
    await page();
    const headers = w.findAll("thead th").map((th) => th.text());
    expect(headers).toEqual(expect.arrayContaining(["Started", "Channel", "Device", "First line", "Entries", "Duration"]));
  });
});
