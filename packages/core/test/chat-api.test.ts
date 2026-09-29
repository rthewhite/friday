import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { ChatEngine } from "../src/chat/engine.js";
import type { StreamChunk, StreamEnd } from "../src/llm/gemini.js";
import type { StreamCallRequest } from "../src/llm/service.js";
import { setup } from "./conversation-fixtures.js";
import { waitFor } from "./helpers.js";

const quiet = { log() {}, warn() {}, error() {} };
const end: StreamEnd = { finishReason: "STOP", model: "m", usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } };
const text = (t: string): StreamChunk => ({ kind: "text", text: t, part: { text: t } });
const call = (name: string): StreamChunk => ({ kind: "call", name, args: {}, part: { functionCall: { name, args: {} } } });

/** Plays a tool call on the first model call of each turn and an answer on the second. */
const toolThenAnswer = {
  async streamCall(_owner: string, req: StreamCallRequest, onChunk: (c: StreamChunk) => void) {
    const last = req.contents.at(-1)!;
    const answered = last.parts?.some((p) => p.functionResponse);
    for (const c of answered ? [text("It is "), text("ten.")] : [call("get_current_time")]) onChunk(c);
    return end;
  },
};

async function start(o: { chat?: boolean; heartbeatMs?: number; tool?: () => unknown } = {}) {
  const { store } = setup();
  const registry = new ToolRegistry(quiet);
  registry.add("builtin", { name: "get_current_time", description: "", handler: async () => (o.tool ? o.tool() : { human: "ten" }) as Record<string, unknown> });
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  const chat = o.chat === false ? undefined : new ChatEngine({ store, registry, llm: toolThenAnswer, model: "m", system: () => "s", toolTimeoutMs: 5000, log: quiet });
  const server = createServer(createApp({ registry, host, mcp: new McpSource(registry, undefined, { log: quiet }), webDir: "/nonexistent", conversations: store, chat, chatHeartbeatMs: o.heartbeatMs }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, init: RequestInit = {}) =>
    fetch(`${base}/api/chat`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { base, post, store, close: async () => { server.closeAllConnections(); server.close(); await once(server, "close"); } };
}

/** Parses an SSE body into events and comment lines. */
function parse(body: string) {
  const events: { event: string; data: any }[] = [];
  let comments = 0;
  for (const block of body.split("\n\n")) {
    if (!block.trim()) continue;
    if (block.startsWith(":")) {
      comments++;
      continue;
    }
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
    const data = /^data: (.*)$/m.exec(block)?.[1];
    events.push({ event, data: data ? JSON.parse(data) : undefined });
  }
  return { events, comments };
}

test("a tool-using turn streams start, tool_call, tool_result, text and done as server-sent events", async () => {
  const s = await start();
  try {
    const res = await s.post({ text: "what time is it?" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /^text\/event-stream/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const { events } = parse(await res.text());
    const id = events[0].data.conversationId;
    assert.deepEqual(events, [
      { event: "start", data: { conversationId: id } },
      { event: "tool_call", data: { id: 1, name: "get_current_time", args: {} } },
      { event: "tool_result", data: { id: 1, name: "get_current_time", result: { human: "ten" } } },
      { event: "text", data: { text: "It is " } },
      { event: "text", data: { text: "ten." } },
      { event: "done", data: { conversationId: id } },
    ]);
    const c = await (await fetch(`${s.base}/api/conversations/${id}`)).json();
    assert.equal(c.channel, "chat");
    assert.deepEqual(c.entries.map((e: any) => e.kind), ["user", "tool", "assistant"]);
    // The next message on the same thread appends to it.
    const again = parse(await (await s.post({ text: "and now?", conversationId: id })).text());
    assert.equal(again.events.at(-1)!.event, "done");
    assert.equal((await (await fetch(`${s.base}/api/conversations/${id}`)).json()).entryCount, 6);
  } finally {
    await s.close();
  }
});

test("validation answers JSON before any stream: 400, 404 for unknown and voice ids, 503 without chat", async () => {
  const s = await start();
  try {
    assert.equal((await s.post({ text: "" })).status, 400);
    assert.equal((await s.post({})).status, 400);
    assert.equal((await s.post("{nope")).status, 400);
    const big = await s.post({ text: "x".repeat(150_000) });
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /too large/);
    assert.equal(s.store.list().length, 0);
    const unknown = await s.post({ text: "hi", conversationId: "nope" });
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("content-type")!, /application\/json/);
    const voice = s.store.create({ channel: "voice" });
    assert.equal((await s.post({ text: "hi", conversationId: voice })).status, 404);
    assert.equal(s.store.get(voice)!.entryCount, 0);
  } finally {
    await s.close();
  }
  const off = await start({ chat: false });
  try {
    assert.equal((await off.post({ text: "hi" })).status, 503);
  } finally {
    await off.close();
  }
});

test("while a turn runs: a second message is 409 and DELETE is 409; both work once it ended", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await start({ tool: async () => (await gate, { human: "ten" }) });
  try {
    const first = await s.post({ text: "what time is it?" });
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("tool_call")) seen += decoder.decode((await reader.read()).value);
    const id = parse(seen).events[0].data.conversationId;
    assert.equal((await s.post({ text: "again", conversationId: id })).status, 409);
    assert.equal((await fetch(`${s.base}/api/conversations/${id}`, { method: "DELETE" })).status, 409);
    release();
    for (let r = await reader.read(); !r.done; r = await reader.read()) seen += decoder.decode(r.value);
    assert.equal(parse(seen).events.at(-1)!.event, "done");
    assert.equal((await s.post({ text: "again", conversationId: id })).status, 200);
    await waitFor(() => !s.store.isLive(id));
    assert.equal((await fetch(`${s.base}/api/conversations/${id}`, { method: "DELETE" })).status, 204);
  } finally {
    await s.close();
  }
});

test("heartbeat comments keep the stream alive while a tool runs", async () => {
  const s = await start({ heartbeatMs: 10, tool: async () => (await new Promise((r) => setTimeout(r, 80)), { human: "ten" }) });
  try {
    const { events, comments } = parse(await (await s.post({ text: "slow" })).text());
    assert.ok(comments >= 2, `expected heartbeats, got ${comments}`);
    assert.equal(events.at(-1)!.event, "done");
  } finally {
    await s.close();
  }
});

test("a client that disconnects mid-turn does not stop it: the answer is still recorded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let settled = false;
  const s = await start({ tool: async () => (await gate, (settled = true), { human: "ten" }) });
  try {
    const ac = new AbortController();
    const res = await s.post({ text: "what time is it?" }, { signal: ac.signal });
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("tool_call")) seen += new TextDecoder().decode((await reader.read()).value);
    const id = parse(seen).events[0].data.conversationId;
    ac.abort();
    await reader.cancel().catch(() => {});
    release();
    await waitFor(() => !s.store.isLive(id));
    assert.equal(settled, true);
    const c = s.store.get(id)!;
    assert.deepEqual(c.entries.map((e) => e.kind), ["user", "tool", "assistant"]);
    assert.equal((c.entries[2] as { text: string }).text, "It is ten.");
  } finally {
    await s.close();
  }
});

test("a cross-origin POST /api/chat is refused with 403 and records nothing", async () => {
  const s = await start();
  try {
    const res = await s.post({ text: "turn off all lights" }, { headers: { origin: "https://evil.example", "content-type": "text/plain" } });
    assert.equal(res.status, 403);
    assert.equal(s.store.list().length, 0);
    const site = await s.post({ text: "turn off all lights" }, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(site.status, 403);
  } finally {
    await s.close();
  }
});
