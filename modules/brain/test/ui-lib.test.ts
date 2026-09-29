import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBody } from "../src/ui/lib/markdown.js";
import { lineDiff } from "../src/ui/lib/diff.js";
import { matches, nameKey, parseAliases } from "../src/ui/lib/pages.js";

const ids: Record<string, string> = { anouk: "p-1", noukie: "p-1" };
const resolve = (target: string) => ids[nameKey(target)];

test("a resolved [[link]] renders as an internal link carrying the page id", () => {
  const html = renderBody("Sister: [[Anouk]] and [[ noukie ]]", resolve);
  assert.match(html, /<a href="\/m\/brain\/p\/p-1" class="brain-link" data-brain-page="p-1">Anouk<\/a>/);
  assert.match(html, /data-brain-page="p-1">noukie<\/a>/);
});

test("a dangling [[link]] renders marked, offering to create the page", () => {
  const html = renderBody("Lives in [[Utrecht]].", resolve);
  assert.match(html, /<a href="#" class="brain-link brain-dangling" data-brain-new="Utrecht" title="No page yet: create it">Utrecht<\/a>/);
});

test("raw HTML and script-ish links render as text", () => {
  const html = renderBody('<img src=x onerror=alert(1)>\n\n[[<b>x</b>]] [click](javascript:alert(1)) [[a" onclick="x]]', resolve);
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes("<b>"), html);
  assert.ok(!/href="javascript:/i.test(html), html);
  assert.ok(!html.includes('" onclick="'), html);
  assert.match(html, /data-brain-new="a&quot; onclick=&quot;x"/);
});

test("ordinary markdown still renders, and external links open in a new tab", () => {
  const html = renderBody("## Notes\n- **bold** [site](https://example.org)", resolve);
  assert.match(html, /<h2>Notes<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.org" target="_blank" rel="noopener noreferrer">site<\/a>/);
});

test("the line diff marks added and removed lines", () => {
  assert.deepEqual(lineDiff("intro\nold note\nend", "intro\nnew note\nend\nextra"), [
    { kind: "same", text: "intro" },
    { kind: "del", text: "old note" },
    { kind: "add", text: "new note" },
    { kind: "same", text: "end" },
    { kind: "add", text: "extra" },
  ]);
  assert.deepEqual(lineDiff("", "a"), [{ kind: "add", text: "a" }]);
  assert.deepEqual(lineDiff("a", ""), [{ kind: "del", text: "a" }]);
  assert.deepEqual(lineDiff("same", "same"), [{ kind: "same", text: "same" }]);
});

test("a huge diff keeps the shared lines and falls back to removed-then-added in the middle", () => {
  const head = Array.from({ length: 50 }, (_, i) => `h${i}`);
  const a = [...head, ...Array.from({ length: 3000 }, (_, i) => `a${i}`), "tail"].join("\n");
  const b = [...head, ...Array.from({ length: 3000 }, (_, i) => `b${i}`), "tail"].join("\n");
  const d = lineDiff(a, b);
  assert.equal(d.length, 50 + 3000 + 3000 + 1);
  assert.deepEqual(d[0], { kind: "same", text: "h0" });
  assert.deepEqual(d[50], { kind: "del", text: "a0" });
  assert.deepEqual(d[3050], { kind: "add", text: "b0" });
  assert.deepEqual(d.at(-1), { kind: "same", text: "tail" });
});

test("list search matches every word in name, aliases or body; aliases parse from a comma list", () => {
  const page = { name: "Anouk", aliases: ["Noukie"], body: "Lives in Utrecht" };
  assert.ok(matches(page, "utrecht"));
  assert.ok(matches(page, "NOUKIE utrecht"));
  assert.ok(!matches(page, "amsterdam"));
  assert.ok(matches(page, "  "));
  assert.ok(matches({ name: "Zoë", aliases: [], body: "Café de Jaren" }, "zoe cafe"));
  assert.deepEqual(parseAliases(" Noukie, , Nouk ,"), ["Noukie", "Nouk"]);
});
