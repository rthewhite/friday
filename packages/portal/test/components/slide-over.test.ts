import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import SlideOver from "../../src/components/SlideOver.vue";
import { flushPromises } from "./helpers.js";

/** A fake matchMedia whose `(min-width: 768px)` answer the test flips. */
function fakeMedia(wide: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { matches: wide };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return state.matches; },
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  }));
  return (matches: boolean) => {
    state.matches = matches;
    for (const fn of listeners) fn({ matches });
  };
}

const Host = defineComponent({
  setup(_, { expose }) {
    const open = ref(false);
    const opener = ref<HTMLElement | null>(null);
    expose({ open });
    return () => [
      h("button", { ref: opener, id: "opener", onClick: () => (open.value = true) }, "Open"),
      h(SlideOver, { label: "Menu", id: "menu", open: open.value, "onUpdate:open": (v: boolean) => (open.value = v) }, () => [
        h("a", { href: "/chat", id: "first" }, "Chat"),
        h("button", { id: "second" }, "Close"),
      ]),
    ];
  },
});

let w: VueWrapper<any>;
let widen: (m: boolean) => void;
beforeEach(() => {
  widen = fakeMedia(false);
  document.documentElement.style.overflow = "";
  w = mount(Host, { attachTo: document.body });
});
afterEach(() => {
  w.unmount();
  vi.unstubAllGlobals();
});

const panel = () => document.querySelector<HTMLElement>("#menu");
const backdrop = () => document.querySelector<HTMLElement>("[data-slide-over-backdrop]");
async function openIt() {
  const opener = document.querySelector<HTMLElement>("#opener")!;
  opener.focus();
  opener.click();
  await flushPromises();
  await nextTick();
}

describe("SlideOver", () => {
  it("renders nothing while closed", () => {
    expect(panel()).toBeNull();
    expect(backdrop()).toBeNull();
  });

  it("opens as a labelled dialog over a backdrop, only below md, and moves the focus into it", async () => {
    await openIt();
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(panel()?.getAttribute("aria-label")).toBe("Menu");
    expect(panel()?.className).toContain("fixed");
    expect(panel()?.className).toContain("left-0");
    expect(panel()?.closest(".md\\:hidden")).not.toBeNull();
    expect(backdrop()).not.toBeNull();
    expect(document.activeElement?.id).toBe("first");
  });

  it("slides without motion when reduced motion is asked for", async () => {
    // The transitions carry motion-reduce:transition-none; the classes are on the Transition, so check the source.
    const src = await import("../../src/components/SlideOver.vue?raw");
    expect(src.default.match(/motion-reduce:transition-none/g)?.length).toBe(4);
  });

  it("locks the page's scroll while open and restores what it was", async () => {
    document.documentElement.style.overflow = "clip";
    await openIt();
    expect(document.documentElement.style.overflow).toBe("hidden");
    backdrop()!.click();
    await flushPromises();
    expect(document.documentElement.style.overflow).toBe("clip");
  });

  it("closes on the backdrop and returns the focus to the opener", async () => {
    await openIt();
    backdrop()!.click();
    await flushPromises();
    expect(w.vm.open).toBe(false);
    expect(panel()).toBeNull();
    expect(document.activeElement?.id).toBe("opener");
  });

  it("closes on Escape", async () => {
    await openIt();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(w.vm.open).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("ignores Escape once closed", async () => {
    await openIt();
    backdrop()!.click();
    await flushPromises();
    w.vm.open = true;
    await flushPromises();
    w.vm.open = false;
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(w.vm.open).toBe(false);
  });

  it("closes when the window widens to the desktop layout", async () => {
    await openIt();
    widen(true);
    await flushPromises();
    expect(w.vm.open).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("unlocks the page when unmounted while open", async () => {
    await openIt();
    w.unmount();
    expect(document.documentElement.style.overflow).toBe("");
    w = mount(Host, { attachTo: document.body });
  });
});
