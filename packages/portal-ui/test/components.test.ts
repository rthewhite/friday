import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { Badge, Button, Card, Chip, DataTable, Drawer, Icon, Input, PageLayout, StatusDot, Tabs, defineModuleUi } from "../src/index.js";

const render = (comp: any, props: Record<string, unknown> = {}, slots: Record<string, () => unknown> | string = "x") =>
  renderToString(createSSRApp({ render: () => h(comp, props, typeof slots === "string" ? { default: () => slots } : slots) }));

describe("portal-ui components render", () => {
  it("PageLayout shows eyebrow, title and subtitle", async () => {
    const html = await render(PageLayout, { title: "Modules", subtitle: "sub", eyebrow: "System" });
    expect(html).toContain("Modules");
    expect(html).toContain("sub");
    expect(html).toContain("System");
    expect(html).toContain("uppercase");
  });
  it("Card shows title", async () => {
    expect(await render(Card, { title: "T" })).toContain("<h2");
  });
  it("Button applies variant and disabled", async () => {
    const html = await render(Button, { variant: "danger", disabled: true }, "Del");
    expect(html).toContain("disabled");
    expect(html).toContain("Del");
  });
  it("Input renders label", async () => {
    expect(await render(Input, { label: "Query", modelValue: "abc" })).toContain("Query");
  });
  it("DataTable renders rows, empty state, hidden columns and cell slots", async () => {
    const cols = [{ key: "a", label: "A" }, { key: "b", label: "B", hideBelow: "md" as const }];
    const html = await render(DataTable, { columns: cols, rows: [{ a: "one", b: "two" }], rowKey: "a", clickable: true }, { "cell-a": ({ value }: any) => h("b", value) });
    expect(html).toContain("<b>one</b>");
    expect(html).toContain("hidden md:table-cell");
    expect(html).toContain("cursor-pointer");
    expect(await render(DataTable, { columns: cols, rows: [], rowKey: "a", empty: "none" })).toContain("none");
  });
  it("Badge applies tone", async () => {
    expect(await render(Badge, { tone: "success" }, "ok")).toContain("text-f-success");
  });
  it("Tabs highlights the selected item and shows counts", async () => {
    const html = await render(Tabs, { items: [{ id: "a", label: "A", count: 3 }, { id: "b", label: "B" }], modelValue: "a" });
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(">3<");
  });
  it("StatusDot and Chip render", async () => {
    expect(await render(StatusDot, { tone: "success", label: "loaded" })).toContain("bg-f-success");
    expect(await render(Chip, {}, "media")).toContain("media");
  });
  it("Icon renders svg for known names and text fallback otherwise", async () => {
    expect(await render(Icon, { name: "mic" })).toContain("<svg");
    expect(await render(Icon, { name: "🎙" })).toContain("🎙");
  });
  it("Drawer renders into body only when open", async () => {
    const teleported = async (open: boolean) => {
      const ctx: { teleports?: Record<string, string> } = {};
      await renderToString(createSSRApp({ render: () => h(Drawer, { title: "Edit", open }) }), ctx);
      return ctx.teleports?.body ?? "";
    };
    expect(await teleported(false)).not.toContain("Edit");
    expect(await teleported(true)).toContain("Edit");
  });
  it("defineModuleUi is an identity", () => {
    const ui = defineModuleUi({ id: "x", nav: { label: "X" }, routes: [] });
    expect(ui.id).toBe("x");
  });
});
