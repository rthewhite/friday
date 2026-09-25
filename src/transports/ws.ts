/**
 * Raw WebSocket transport, shared by the web UI and microcontrollers (ESP32 / Voice PE).
 *
 *   endpoint         : GET /ws/audio[?device=<id>]
 *                      `device` is an optional client identifier; it is logged and otherwise
 *                      ignored today. Unknown query parameters are ignored.
 *   client -> server : binary = 16 kHz mono s16le PCM (any frame size up to maxPayload;
 *                      batching e.g. 100 ms per frame is fine)
 *                      text   = JSON {"type":"text","text":"..."}
 *   server -> client : binary = 24 kHz mono s16le PCM
 *                      text   = JSON events: interrupted, user_text, bot_text,
 *                               tool_call, tool_result, turn_complete, closed
 *   keep-alive       : the server pings every FRIDAY_WS_PING_MS (default 20000, 0 disables) and
 *                      terminates a connection that has not answered by the next ping. Client
 *                      pings are answered automatically.
 * On "interrupted" the client must drop its playback buffer.
 */
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { settings } from "../config.js";
import { GeminiSession, type Event } from "../session.js";

/** The subset of GeminiSession the transport relies on; tests inject a stub. */
export interface AudioSession {
  open(): Promise<void>;
  sendAudio(pcm16k: Buffer): Promise<void> | void;
  sendText(text: string): void;
  close(): void;
}

export interface AudioWsOptions {
  /** Ping interval in ms. 0 disables keep-alive. Defaults to settings.wsPingMs. */
  pingMs?: number;
  createSession?: (onEvent: (e: Event) => void) => AudioSession;
  /** Maximum inbound frame size in bytes. Defaults to the ws library default (100 MiB). */
  maxPayload?: number;
}

/** Mount the audio WebSocket on an HTTP server at /ws/audio. */
export function attachAudioWs(server: Server, opts: AudioWsOptions = {}): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/audio", maxPayload: opts.maxPayload });
  const pingMs = opts.pingMs ?? settings.wsPingMs;
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws, req) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    void serveWs(ws, req, opts);
  });

  if (pingMs > 0) {
    const timer = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          console.log("ws: no pong, terminating");
          ws.terminate(); // fires "close" -> session closed
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }, pingMs);
    timer.unref();
    wss.on("close", () => clearInterval(timer));
  }
  return wss;
}

export async function serveWs(ws: WebSocket, req?: IncomingMessage, opts: AudioWsOptions = {}): Promise<void> {
  const device = new URL(req?.url ?? "/", "http://x").searchParams.get("device");
  const tag = device ? `[${device}] ` : "";
  const create = opts.createSession ?? ((onEvent) => new GeminiSession(onEvent));

  const g = create((ev) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ev.kind === "audio") ws.send(ev.data);
    else ws.send(JSON.stringify({ type: ev.kind, data: "data" in ev ? ev.data : undefined }));
    if (ev.kind === "closed") ws.close();
  });

  try {
    await g.open();
    console.log(`ws: ${tag}session open`);
  } catch (e) {
    console.error(`ws: ${tag}could not open gemini session`, e);
    ws.close(1011, "gemini unavailable");
    return;
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) void g.sendAudio(raw as Buffer);
    else {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "text") g.sendText(msg.text);
    }
  });
  const end = () => {
    console.log(`ws: ${tag}connection closed`);
    g.close();
  };
  ws.on("close", end);
  ws.on("error", end);
}
