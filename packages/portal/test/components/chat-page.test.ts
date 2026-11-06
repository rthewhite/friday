import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { ref } from "vue";
import ChatPage from "../../src/pages/ChatPage.vue";
import { DESKTOP } from "../../src/composables/useMediaQuery.js";
import { fakeApi, flushPromises, routerAt } from "./helpers.js";

const api = vi.hoisted(() => ({ impl: (async () => undefined) as (path: string, init?: object) => Promise<unknown> }));
vi.mock("../../src/composables/useApi.js", () => ({ api: (path: string, init?: object) => api.impl(path, init) }));

// The stream itself is tested in use-chat-stream.test.ts; here only what the page sends matters.
const sent = vi.hoisted(() => [] as { text: string; id: string | undefined }[]);
vi.mock("../../src/composables/useChatStream.js", () => ({
  useChatStream: () => ({
    turn: ref(null),
    send: async (text: string, id: string | undefined) => {
      sent.push({ text, id });
      return { conversationId: undefined, ok: false };
    },
  }),
}));

const summary = (id: string, preview: string) => ({
  id, channel: "chat", device: null, startedAt: "2026-11-06T09:00:00Z", lastActivityAt: "2026-11-06T09:01:00Z",
  endedAt: null, endReason: null, quietAt: null, state: "active", entryCount: 2, preview,
});

function wide(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === DESKTOP ? matches : false, media: query, addEventListener() {}, removeEventListener() {} }));
}

let w: VueWrapper;
beforeEach(() => {
  sent.length = 0;
  api.impl = fakeApi({
    "GET /api/conversations?channel=chat": { conversations: [summary("c1", "Tidy desk"), summary("c2", "Groceries")], next: null },
    "GET /api/conversations/c1": { ...summary("c1", "Tidy desk"), entries: [] },
  }).api;
});
afterEach(() => {
  w?.unmount();
  vi.unstubAllGlobals();
  document.documentElement.style.overflow = "";
});

async function page(path = "/chat") {
  const router = await routerAt(path);
  w = mount(ChatPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  return router;
}

const input = () => w.get("textarea");
const sendButton = () => w.get('button[type="submit"]');

describe("Chat page composer", () => {
  it("sends on Enter and not on Shift+Enter", async () => {
    wide(false);
    await page();
    await input().setValue("Hello");
    await input().trigger("keydown", { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    await input().trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sent).toEqual([{ text: "Hello", id: undefined }]);
  });

  it("labels the keyboard's return key as sending", async () => {
    wide(false);
    await page();
    expect(input().attributes("enterkeyhint")).toBe("send");
  });

  it("keeps Send as the button's accessible name, shown only from md up", async () => {
    wide(false);
    await page();
    const label = sendButton().get("span");
    expect(label.text()).toBe("Send");
    expect(label.classes()).toContain("max-md:sr-only");
    expect(sendButton().classes()).toEqual(expect.arrayContaining(["max-md:size-11", "max-md:p-0"]));
  });

  it("is one line with a short placeholder on a phone", async () => {
    wide(false);
    await page();
    expect(input().attributes("rows")).toBe("1");
    expect(input().attributes("placeholder")).toBe("Message Friday…");
    expect(input().classes()).toEqual(expect.arrayContaining(["max-md:resize-none", "max-md:[field-sizing:content]"]));
  });

  it("grows the phone input with its text where the browser has no field-sizing", async () => {
    wide(false);
    vi.stubGlobal("CSS", { supports: () => false });
    await page();
    const el = input().element as HTMLTextAreaElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => (el.value.split("\n").length * 24) + 16 });
    await input().setValue("one\ntwo\nthree\nfour");
    await flushPromises();
    expect(el.style.height).toBe("112px");
    await input().setValue("one");
    await flushPromises();
    expect(el.style.height).toBe("40px");
  });

  it("leaves the height to CSS where the browser has field-sizing", async () => {
    wide(false);
    vi.stubGlobal("CSS", { supports: (p: string) => p === "field-sizing" });
    await page();
    await input().setValue("one\ntwo\nthree");
    await flushPromises();
    expect((input().element as HTMLTextAreaElement).style.height).toBe("");
  });

  it("is two lines with the Shift+Enter hint on the desktop", async () => {
    wide(true);
    await page();
    expect(input().attributes("rows")).toBe("2");
    expect(input().attributes("placeholder")).toBe("Message Friday… (Enter sends, Shift+Enter for a new line)");
  });
});

describe("Chat page thread panel", () => {
  const panel = () => document.querySelector<HTMLElement>("#chat-threads");
  const threadsButton = () => w.get('button[aria-label="Threads"]');

  it("slides the thread list over the thread and closes it when a thread is chosen", async () => {
    wide(false);
    const router = await page();
    expect(panel()).toBeNull();
    await threadsButton().trigger("click");
    await flushPromises();
    expect(threadsButton().attributes("aria-expanded")).toBe("true");
    expect(panel()?.textContent).toContain("Groceries");
    panel()!.querySelector<HTMLElement>('a[href="/chat/c1"]')!.click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/chat/c1");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(threadsButton().element);
  });

  it("closes the panel on New chat, also when already on a new chat", async () => {
    wide(false);
    await page("/chat");
    await threadsButton().trigger("click");
    await flushPromises();
    const newChat = [...panel()!.querySelectorAll("button")].find((b) => b.textContent?.includes("New chat"))!;
    newChat.click();
    await flushPromises();
    expect(panel()).toBeNull();
  });

  it("keeps the column for the desktop", async () => {
    wide(true);
    await page();
    const column = w.get("aside");
    expect(column.classes()).toEqual(expect.arrayContaining(["hidden", "md:flex", "w-72"]));
    expect(column.text()).toContain("Tidy desk");
  });
});
