import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/lib/markdown.ts";
import { SseParser } from "../src/lib/sse.ts";

test("markdown: raw HTML is shown as text, never as markup", () => {
  const html = renderMarkdown("Look: <img src=x onerror=alert(1)> and <script>alert(2)</script>");
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;/);
});

test("markdown: links open in a new tab without the opener; javascript: links are not links", () => {
  const html = renderMarkdown("[docs](https://example.com) and https://jellyfin.org and [x](javascript:alert(1))");
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<a href="https:\/\/jellyfin.org" target="_blank" rel="noopener noreferrer">/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("markdown: lists, emphasis and code render", () => {
  const html = renderMarkdown("**Dune**\n\n- 1984\n- 2021\n\n`code`");
  assert.match(html, /<strong>Dune<\/strong>/);
  assert.match(html, /<li>1984<\/li>/);
  assert.match(html, /<code>code<\/code>/);
});

test("sse: events split across chunks, several per chunk, and comment lines", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("event: start\ndata: {\"conversationId\""), []);
  assert.deepEqual(p.push(":\"c1\"}\n\n: ping\n\nevent: text\ndata: {\"text\":\"Hi\"}\n\nevent: te"), [
    { event: "start", data: '{"conversationId":"c1"}' },
    { event: "text", data: '{"text":"Hi"}' },
  ]);
  assert.deepEqual(p.push("xt\ndata: {\"text\":\"!\"}\n\n"), [{ event: "text", data: '{"text":"!"}' }]);
});

test("sse: CRLF line endings, multi-line data and events without a name", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("event: done\r\ndata: a\r\ndata: b\r\n\r\ndata: plain\n\n"), [
    { event: "done", data: "a\nb" },
    { event: "message", data: "plain" },
  ]);
  assert.deepEqual(p.push(": only a comment\n\n"), []);
});
