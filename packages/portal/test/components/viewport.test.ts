import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { DESKTOP, useMediaQuery } from "../../src/composables/useMediaQuery.js";
import { useVisualViewportHeight } from "../../src/composables/useVisualViewportHeight.js";

type Listener = (e: { matches: boolean }) => void;
/** matchMedia answering `wide` for the desktop query; returns a function that flips it and tells the listeners. */
function fakeMedia(wide: boolean) {
  const listeners = new Set<Listener>();
  let matches = wide;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === DESKTOP ? matches : false; },
    media: query,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }));
  return {
    set(m: boolean) { matches = m; for (const fn of listeners) fn({ matches: m }); },
    listeners,
  };
}

class FakeViewport extends EventTarget {
  height = 700;
  offsetTop = 0;
  scale = 1;
}

const root = document.documentElement;
const viewportH = () => root.style.getPropertyValue("--f-viewport-h");

afterEach(() => {
  vi.unstubAllGlobals();
  root.style.removeProperty("--f-viewport-h");
});

describe("useMediaQuery", () => {
  it("follows the query and stops listening on unmount", async () => {
    const media = fakeMedia(false);
    let value: { value: boolean } | undefined;
    const w = mount(defineComponent({ setup() { value = useMediaQuery(DESKTOP); return () => h("p", String(value!.value)); } }));
    expect(w.text()).toBe("false");
    media.set(true);
    await nextTick();
    expect(w.text()).toBe("true");
    w.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const w = mount(defineComponent({ setup() { const m = useMediaQuery(DESKTOP); return () => h("p", String(m.value)); } }));
    expect(w.text()).toBe("false");
  });
});

describe("useVisualViewportHeight", () => {
  let vv: FakeViewport;
  let scrollTo: ReturnType<typeof vi.fn>;
  let frames: FrameRequestCallback[];
  /** Run the animation frames requested so far. */
  const flush = () => { const run = frames; frames = []; for (const f of run) f(0); };
  beforeEach(() => {
    vv = new FakeViewport();
    vi.stubGlobal("visualViewport", vv);
    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
    fakeMedia(false);
  });
  const Page = defineComponent({ setup() { useVisualViewportHeight(); return () => h("div"); } });

  it("sets the visible height on mount and follows the keyboard, undoing iOS's pan", () => {
    const w = mount(Page);
    expect(viewportH()).toBe("700px");
    vv.height = 380; // the keyboard opened
    vv.offsetTop = 220; // and iOS panned the page up
    vv.dispatchEvent(new Event("resize"));
    flush();
    expect(viewportH()).toBe("380px");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    w.unmount();
  });

  it("coalesces a burst of events into one update per frame", () => {
    const w = mount(Page);
    const set = vi.spyOn(root.style, "setProperty");
    for (const h of [600, 500, 400]) {
      vv.height = h;
      vv.dispatchEvent(new Event("scroll"));
    }
    expect(frames).toHaveLength(1);
    flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(viewportH()).toBe("400px");
    // Unchanged height: nothing written.
    vv.dispatchEvent(new Event("scroll"));
    flush();
    expect(set).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("follows the height on a viewport scroll without scrolling the page back", () => {
    const w = mount(Page);
    vv.offsetTop = 120; // iOS keeping the caret in view
    vv.height = 420;
    vv.dispatchEvent(new Event("scroll"));
    flush();
    expect(viewportH()).toBe("420px");
    expect(scrollTo).not.toHaveBeenCalled();
    w.unmount();
  });

  it("leaves the page alone while the user has pinch-zoomed", () => {
    const w = mount(Page);
    vv.scale = 2;
    vv.height = 350;
    vv.offsetTop = 100;
    vv.dispatchEvent(new Event("resize"));
    flush();
    expect(viewportH()).toBe("700px");
    expect(scrollTo).not.toHaveBeenCalled();
    w.unmount();
  });

  it("doesn't scroll on the desktop layout", () => {
    fakeMedia(true);
    const w = mount(Page);
    vv.offsetTop = 50;
    vv.dispatchEvent(new Event("resize"));
    flush();
    expect(scrollTo).not.toHaveBeenCalled();
    w.unmount();
  });

  it("removes the variable, its listeners and a pending frame on unmount", () => {
    const w = mount(Page);
    vv.height = 500;
    vv.dispatchEvent(new Event("resize"));
    w.unmount();
    expect(frames).toHaveLength(0);
    expect(viewportH()).toBe("");
    vv.height = 300;
    vv.dispatchEvent(new Event("resize"));
    flush();
    expect(viewportH()).toBe("");
  });

  it("does nothing without visualViewport, so the page keeps its 100dvh fallback", () => {
    vi.stubGlobal("visualViewport", null);
    const w = mount(Page);
    expect(viewportH()).toBe("");
    w.unmount();
  });
});
