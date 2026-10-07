/**
 * Raw WebSocket transport, shared by the web UI and microcontrollers (ESP32 / Voice PE).
 *
 *   endpoint         : GET /ws/audio[?device=<id>]
 *                      `device` identifies a registered voice device and needs its key in an
 *                      `Authorization: Bearer <key>` header. It is checked before any Gemini
 *                      session opens; a rejected connection is closed at once with
 *                      4400 bad device (malformed id or key), 4401 unauthorized (no key, or the
 *                      device is revoked) or 4403 pending approval (unknown id or a different key,
 *                      recorded for the portal to accept); 1011 internal error when the device
 *                      store fails. An accepted device is logged, recorded
 *                      as the conversation's device and gets its device block in the prompt.
 *                      Without `device` no key is needed (the portal's Talk page). Unknown query
 *                      parameters are ignored.
 *   client -> server : binary = 16 kHz mono s16le PCM (any frame size up to maxPayload;
 *                      batching e.g. 100 ms per frame is fine)
 *                      text   = JSON {"type":"text","text":"..."}
 *   server -> client : binary = 24 kHz mono s16le PCM
 *                      text   = JSON events: interrupted, user_text, bot_text,
 *                               tool_call, tool_result, turn_complete, closed; a device
 *                               connection gets interrupted, turn_complete and closed only
 *   keep-alive       : the server pings every FRIDAY_WS_PING_MS (default 20000, 0 disables) and
 *                      terminates a connection that has not answered by the next ping. Client
 *                      pings are answered automatically.
 * On "interrupted" the client must drop its playback buffer. Revoking a device, deleting it or
 * replacing its key closes its open connections with 4401.
 */
import type { IncomingMessage, Server } from "node:http";
import type { WebSocketServer, WebSocket } from "ws";
import type { PromptContext, ToolRegistry } from "@friday/sdk";
import { settings } from "../config.js";
import { systemPrompt } from "../prompt-context.js";
import { GeminiSession, type Event } from "../session.js";
import type { ConversationRecorder } from "../conversations/recorder.js";
import type { ConversationStore } from "../conversations/store.js";
import type { AuthResult, DeviceSnapshot, DeviceStore } from "../devices/store.js";
import type { DeviceSessions } from "../devices/sessions.js";
import { keepAlive } from "./keep-alive.js";
import { mountWs } from "./mount.js";

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
  /** Receives the connection's recorder (when a conversation store is given) and its accepted device, if any. */
  createSession?: (onEvent: (e: Event) => void, recorder?: ConversationRecorder, device?: DeviceSnapshot) => AudioSession;
  /** Registry new GeminiSessions snapshot their tools from. Required unless createSession is given. */
  registry?: ToolRegistry;
  /** Maximum inbound frame size in bytes. Defaults to the ws library default (100 MiB). */
  maxPayload?: number;
  /** Records each connection as a `voice` conversation. Without it nothing is recorded. */
  conversations?: Pick<ConversationStore, "recorder">;
  /** Gemini API key for new default sessions, resolved when each opens. Defaults to the environment. */
  geminiKey?: () => string | undefined;
  /** Module prompt context; new default sessions append its `voice` rendering to the voice prompt when they open. */
  promptContext?: Pick<PromptContext, "render">;
  /** Authenticates `?device=` connections. Without it every such connection is closed with 4401. */
  devices?: Pick<DeviceStore, "authenticate">;
  /** Tracks accepted device connections so revoking a device can close them. */
  deviceSessions?: DeviceSessions;
}

const UNAUTHORIZED: AuthResult = { ok: false, code: 4401, reason: "unauthorized" };

/** The session events a voice-device connection receives. */
const DEVICE_EVENTS: ReadonlySet<Event["kind"]> = new Set(["audio", "interrupted", "turn_complete", "closed"]);

/** The key from `Authorization: Bearer <key>`, or undefined. A key in the query string is never read. */
function bearerKey(req: IncomingMessage | undefined): string | undefined {
  return /^Bearer\s+(\S+)\s*$/i.exec(req?.headers.authorization ?? "")?.[1];
}

/** Mount the audio WebSocket on an HTTP server at /ws/audio. */
export function attachAudioWs(server: Server, opts: AudioWsOptions = {}): WebSocketServer {
  const wss = mountWs(server, "/ws/audio", { maxPayload: opts.maxPayload });
  keepAlive(wss, opts.pingMs ?? settings.wsPingMs);
  wss.on("connection", (ws, req) => void serveWs(ws, req, opts));
  return wss;
}

export async function serveWs(ws: WebSocket, req?: IncomingMessage, opts: AudioWsOptions = {}): Promise<void> {
  const claimed = new URL(req?.url ?? "/", "http://x").searchParams.get("device");
  let device: DeviceSnapshot | undefined;
  if (claimed !== null) {
    let auth: AuthResult;
    try {
      auth = opts.devices?.authenticate(claimed, bearerKey(req)) ?? UNAUTHORIZED;
    } catch (e) {
      // serveWs runs unawaited: a store error (a locked or full database) must close this socket, not the process.
      console.error(`ws: [${JSON.stringify(claimed.slice(0, 64))}] could not check the device`, e);
      ws.close(1011, "internal error");
      return;
    }
    if (!auth.ok) {
      // Frames sent before the close are dropped: no message handler is attached.
      console.log(`ws: [${JSON.stringify(claimed.slice(0, 64))}] rejected: ${auth.code} ${auth.reason}`);
      ws.close(auth.code, auth.reason);
      return;
    }
    device = auth.device;
  }
  const tag = device ? `[${device.id}] ` : "";
  const create =
    opts.createSession ??
    ((onEvent, recorder, device) => {
      if (!opts.registry) throw new Error("attachAudioWs needs a registry or createSession");
      return new GeminiSession(onEvent, opts.registry, { recorder, geminiKey: opts.geminiKey, systemPrompt: systemPrompt(opts.promptContext, "voice", device) });
    });
  const recorder = opts.conversations?.recorder({ channel: "voice", device: device?.id ?? null });
  if (device && opts.deviceSessions) {
    const { id } = device, sessions = opts.deviceSessions;
    sessions.add(id, ws);
    ws.once("close", () => sessions.remove(id, ws));
  }

  const g = create((ev) => {
    if (ws.readyState !== ws.OPEN) return;
    // Devices act on audio and the control events only. Transcripts and tool activity are for the browser, and a
    // tool result can be larger than a device can buffer. The recorder gets them from the session either way.
    if (device && !DEVICE_EVENTS.has(ev.kind)) return;
    if (ev.kind === "audio") ws.send(ev.data);
    else ws.send(JSON.stringify({ type: ev.kind, data: "data" in ev ? ev.data : undefined }));
    if (ev.kind === "closed") ws.close();
  }, recorder, device);

  try {
    await g.open();
    // Closed while Gemini was connecting (the client left, or the device was revoked): nothing would close it later.
    if (ws.readyState !== ws.OPEN) {
      g.close();
      return;
    }
    console.log(`ws: ${tag}session open`);
  } catch (e) {
    console.error(`ws: ${tag}could not open gemini session`, e);
    ws.close(1011, "gemini unavailable");
    return;
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) void g.sendAudio(raw as Buffer);
    else {
      // Anyone may send text without a key: a malformed frame is dropped, never thrown out of the listener.
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg !== null && typeof msg === "object" && "type" in msg && msg.type === "text" && "text" in msg && typeof msg.text === "string")
        g.sendText(msg.text);
    }
  });
  const end = () => {
    console.log(`ws: ${tag}connection closed`);
    g.close();
  };
  ws.on("close", end);
  ws.on("error", end);
}
