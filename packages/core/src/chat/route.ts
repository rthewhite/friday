/**
 * `POST /api/chat`: `{ text, conversationId? }` answered with a server-sent event stream of the turn
 * (`start`, `thinking`, `text`, `tool_call`, `tool_result`, then `done` or `error`). Validation
 * failures answer plain JSON before any stream starts. A comment line every `heartbeatMs` keeps
 * proxies from closing a stream that is waiting on a slow tool. When the client goes away the turn
 * carries on and is recorded; only its events are dropped.
 */
import type { NodeHandler } from "../router.js";
import { readBody, sendJson } from "../router.js";
import type { ChatEngine } from "./engine.js";

export const HEARTBEAT_MS = 15_000;
const MAX_BODY = 100_000;

export function chatRoute(engine: ChatEngine | undefined, opts: { heartbeatMs?: number } = {}): NodeHandler {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  return async (req, res) => {
    if (!engine) return sendJson(res, { error: "chat is not available" }, 503);
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY);
    } catch {
      return sendJson(res, { error: `message too large (limit ${MAX_BODY / 1000} kB)` }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, { error: "invalid JSON body" }, 400);
    }
    const begun = engine.begin((typeof body === "object" && body !== null ? body : {}) as Parameters<ChatEngine["begin"]>[0]);
    if (!begun.ok) return sendJson(res, { error: begun.error }, begun.status);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.flushHeaders();
    // A client that went away must not turn later writes into unhandled errors.
    res.on("error", () => {});
    const open = () => !res.writableEnded && !res.destroyed;
    const write = (chunk: string) => {
      if (open()) res.write(chunk);
    };
    const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    try {
      await begun.turn.run((e) => write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
    } finally {
      clearInterval(heartbeat);
      if (open()) res.end();
    }
  };
}
