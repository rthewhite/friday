import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import Shell from "../../src/shell/Shell.vue";
import { me } from "../../src/composables/useSession.js";
import { flushPromises, routerAt } from "./helpers.js";

vi.mock("../../src/composables/useApi.js", () => ({ api: async () => undefined }));

let w: VueWrapper;
beforeEach(() => {
  me.value = { id: "u1", name: "Raymond", role: "admin", authEnabled: false } as typeof me.value;
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => [] }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  w?.unmount();
  vi.unstubAllGlobals();
  document.documentElement.style.overflow = "";
});

async function shell(path = "/conversations") {
  const router = await routerAt(path);
  w = mount(Shell, { global: { plugins: [router], provide: { moduleUis: [] } }, attachTo: document.body });
  await flushPromises();
  return router;
}

const menuButton = () => w.get('button[aria-label="Menu"]');
const panel = () => document.querySelector<HTMLElement>("#phone-menu");

describe("Shell", () => {
  it("keeps the desktop sidebar as a column from md up", async () => {
    await shell();
    const column = w.findAll("nav").find((n) => n.classes().includes("md:sticky"));
    expect(column?.classes()).toEqual(expect.arrayContaining(["hidden", "md:block", "md:w-60", "md:h-screen"]));
    expect(column?.text()).toContain("Conversations");
    // The top bar is for phones only.
    expect(w.get("header").classes()).toContain("md:hidden");
  });

  it("opens the phone menu over the page and reports it on the button", async () => {
    await shell();
    expect(menuButton().attributes("aria-expanded")).toBe("false");
    expect(menuButton().attributes("aria-controls")).toBe("phone-menu");
    expect(panel()).toBeNull();
    await menuButton().trigger("click");
    await flushPromises();
    expect(menuButton().attributes("aria-expanded")).toBe("true");
    expect(panel()?.textContent).toContain("Chat");
    expect(panel()?.textContent).toContain("Configuration");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("closes the menu when an item is chosen and returns the focus to the menu button", async () => {
    const router = await shell();
    await menuButton().trigger("click");
    await flushPromises();
    panel()!.querySelector<HTMLElement>('a[href="/chat"]')!.click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/chat");
    expect(panel()).toBeNull();
    expect(menuButton().attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menuButton().element);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("closes the menu when the page already shown is chosen", async () => {
    const router = await shell("/conversations");
    await menuButton().trigger("click");
    await flushPromises();
    panel()!.querySelector<HTMLElement>('a[href="/conversations"]')!.click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/conversations");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(menuButton().element);
  });

  it("closes the menu with its close button", async () => {
    await shell();
    await menuButton().trigger("click");
    await flushPromises();
    panel()!.querySelector<HTMLElement>('button[aria-label="Close menu"]')!.click();
    await flushPromises();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(menuButton().element);
  });
});
