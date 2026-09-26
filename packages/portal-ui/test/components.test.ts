import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { Badge, Button, Card, Input, PageLayout, Table, defineModuleUi } from "../src/index.js";

const render = (comp: any, props: Record<string, unknown> = {}, slot = "x") =>
  renderToString(createSSRApp({ render: () => h(comp, props, { default: () => slot }) }));

describe("portal-ui components render", () => {
  it("PageLayout shows title and subtitle", async () => {
    const html = await render(PageLayout, { title: "Modules", subtitle: "sub" });
    expect(html).toContain("Modules");
    expect(html).toContain("sub");
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
  it("Table renders rows and empty state", async () => {
    const cols = [{ key: "a", label: "A" }];
    expect(await render(Table, { columns: cols, rows: [{ a: "one" }], rowKey: "a" })).toContain("one");
    expect(await render(Table, { columns: cols, rows: [], rowKey: "a", empty: "none" })).toContain("none");
  });
  it("Badge applies tone", async () => {
    expect(await render(Badge, { tone: "success" }, "ok")).toContain("text-f-success");
  });
  it("defineModuleUi is an identity", () => {
    const ui = defineModuleUi({ id: "x", nav: { label: "X" }, routes: [] });
    expect(ui.id).toBe("x");
  });
});
