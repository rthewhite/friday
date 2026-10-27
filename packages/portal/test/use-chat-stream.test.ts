import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { useChatStream } from "../src/composables/useChatStream.ts";

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A fake /api/chat: records the request and streams `chunks` (split anywhere, as the network may). */
function fakeChat(chunks: string[], opts: { status?: number; json?: unknown; breakAfter?: number } = {}) {
  const requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    if (opts.status && opts.status >= 400) return new Response(JSON.stringify(opts.json ?? {}), { status: opts.status, statusText: "Bad" });
    const enc = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (opts.breakAfter !== undefined && i === opts.breakAfter) return c.error(new TypeError("network error"));
        if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
        else c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return requests;
}

/** Cut a stream into pieces of `n` characters, so events and even JSON straddle chunks. */
const pieces = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) ?? [];

test("a turn streams thinking and text, names the conversation at start, and ends ok", async () => {
  const stream = sse("start", { conversationId: "c1" }) + sse("thinking", { text: "Let me " }) + sse("thinking", { text: "think." })
    + sse("text", { text: "Hello" }) + sse("text", { text: ", world" }) + sse("done", {});
  const requests = fakeChat(pieces(stream, 7));
  const { turn, send } = useChatStream();
  const started: string[] = [];
  const r = await send("hi", undefined, (id) => started.push(id));
  assert.deepEqual(r, { conversationId: "c1", ok: true });
  assert.deepEqual(started, ["c1"]);
  assert.deepEqual(requests, [{ url: "/api/chat", body: { text: "hi" } }]);
  assert.deepEqual(turn.value!.items.map((i) => [i.kind, "text" in i ? i.text : ""]), [["thinking", "Let me think."], ["text", "Hello, world"]]);
  assert.deepEqual([turn.value!.error, turn.value!.running], [null, false]);
});

test("an existing thread sends its id; parallel tool calls settle by call id, in any order", async () => {
  const stream = sse("start", { conversationId: "c1" })
    + sse("tool_call", { id: 1, name: "weather", args: { city: "A" } }) + sse("tool_call", { id: 2, name: "weather", args: { city: "B" } })
    + sse("tool_result", { id: 2, name: "weather", result: { c: 12 } }) + sse("tool_result", { id: 1, name: "weather", result: { c: 9 } })
    + sse("text", { text: "A 9, B 12." }) + sse("done", {});
  const requests = fakeChat([stream]);
  const { turn, send } = useChatStream();
  await send("weather?", "c1");
  assert.deepEqual(requests[0]!.body, { text: "weather?", conversationId: "c1" });
  const tools = turn.value!.items.filter((i) => i.kind === "tool");
  assert.deepEqual(tools.map((t) => [t.callId, t.args, t.result, t.settled]), [[1, { city: "A" }, { c: 9 }, true], [2, { city: "B" }, { c: 12 }, true]]);
  assert.ok(tools.every((t) => !Number.isNaN(Date.parse(t.at))));
  assert.equal(turn.value!.items.at(-1)!.kind, "text");
});

test("a refused message shows the server's error, or the status without one, and has no conversation", async () => {
  fakeChat([], { status: 400, json: { error: "text is required" } });
  const a = useChatStream();
  assert.deepEqual(await a.send("", undefined), { conversationId: undefined, ok: false });
  assert.equal(a.turn.value!.error, "text is required");

  fakeChat([], { status: 503 });
  const b = useChatStream();
  await b.send("hi", undefined);
  assert.equal(b.turn.value!.error, "503 Bad");
  assert.equal(b.turn.value!.running, false);
});

test("an error event shows its message, else its kind", async () => {
  fakeChat([sse("start", { conversationId: "c1" }) + sse("error", { kind: "rate_limited", message: "Too many requests, try again in a minute." })]);
  const a = useChatStream();
  assert.deepEqual(await a.send("hi", undefined), { conversationId: "c1", ok: false });
  assert.equal(a.turn.value!.error, "Too many requests, try again in a minute.");

  fakeChat([sse("start", { conversationId: "c1" }) + sse("error", { kind: "unavailable" })]);
  const b = useChatStream();
  await b.send("hi", undefined);
  assert.equal(b.turn.value!.error, "unavailable");
});

test("a stream that ends or breaks before done is an error, but keeps what arrived and the conversation", async () => {
  fakeChat([sse("start", { conversationId: "c1" }) + sse("text", { text: "Half an ans" })]);
  const a = useChatStream();
  assert.deepEqual(await a.send("hi", undefined), { conversationId: "c1", ok: false });
  assert.equal(a.turn.value!.error, "the connection closed before the answer finished");
  assert.equal(a.turn.value!.items[0]!.kind === "text" && a.turn.value!.items[0]!.text, "Half an ans");

  fakeChat([sse("start", { conversationId: "c2" }), sse("text", { text: "x" })], { breakAfter: 1 });
  const b = useChatStream();
  assert.deepEqual(await b.send("hi", undefined), { conversationId: "c2", ok: false });
  assert.equal(b.turn.value!.error, "network error");
  assert.equal(b.turn.value!.running, false);
});

test("a request that never reaches the server is an error", async () => {
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  const { turn, send } = useChatStream();
  assert.deepEqual(await send("hi", undefined), { conversationId: undefined, ok: false });
  assert.deepEqual([turn.value!.error, turn.value!.running], ["Failed to fetch", false]);
});
