/**
 * Control connection for voice devices, kept open while a device is idle so Friday can reach it.
 *
 *   endpoint         : GET /ws/device?device=<id>, authenticated exactly like /ws/audio?device= (the key in
 *                      `Authorization: Bearer <key>`; 4400 bad device, 4401 unauthorized, 4403 pending approval
 *                      recorded for the portal; 1011 when the device store fails). Without `device`: 4400.
 *                      A newer connection of the same device replaces the older one, which is closed with 4409.
 *   server -> device : {"type":"ring","data":{"alert":"<id>"}}  open /ws/audio?device=<id>&alert=<id>
 *                      {"type":"stop","data":{"alert":"<id>"}}  stop ringing that alert locally
 *   device -> server : {"type":"ringing_locally"|"acknowledged"|"unanswered","alert":"<id>"}
 *                      anything else, and every binary frame, is ignored
 *   keep-alive       : as /ws/audio (FRIDAY_WS_PING_MS).
 * No audio and no Gemini session ever go over this connection.
 */
import type { IncomingMessage, Server } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { settings } from "../config.js";
import type { DeviceLinks } from "../devices/links.js";
import type { DeviceStore } from "../devices/store.js";
import { authenticateDevice } from "./device-auth.js";
import { keepAlive } from "./keep-alive.js";
import { mountWs } from "./mount.js";

export type DeviceReport = "ringing_locally" | "acknowledged" | "unanswered";
const REPORTS: ReadonlySet<string> = new Set<DeviceReport>(["ringing_locally", "acknowledged", "unanswered"]);
/** Control frames are a few dozen bytes; anything much larger isn't one. */
const MAX_FRAME = 4096;

export interface DeviceWsOptions {
  /** Ping interval in ms. 0 disables keep-alive. Defaults to settings.wsPingMs. */
  pingMs?: number;
  /** Authenticates connections. Without it every connection is closed with 4401. */
  devices?: Pick<DeviceStore, "authenticate">;
  links: DeviceLinks;
  /** Receives what a device reports about an alert it rings. */
  onReport?: (deviceId: string, type: DeviceReport, alertId: string) => void;
}

/** Mount the control WebSocket on an HTTP server at /ws/device. */
export function attachDeviceWs(server: Server, opts: DeviceWsOptions): WebSocketServer {
  const wss = mountWs(server, "/ws/device", { maxPayload: MAX_FRAME });
  keepAlive(wss, opts.pingMs ?? settings.wsPingMs);
  wss.on("connection", (ws, req) => serveDeviceWs(ws, req, opts));
  return wss;
}

export function serveDeviceWs(ws: WebSocket, req: IncomingMessage | undefined, opts: DeviceWsOptions): void {
  const claimed = new URL(req?.url ?? "/", "http://x").searchParams.get("device");
  if (claimed === null) {
    console.log("device-ws: rejected: no device");
    ws.close(4400, "bad device");
    return;
  }
  const device = authenticateDevice(ws, req, opts.devices, claimed, "device-ws");
  if (!device) return;
  const { id } = device;
  opts.links.add(id, ws);
  console.log(`device-ws: [${id}] online`);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    const { type, alert } = msg as { type?: unknown; alert?: unknown };
    if (typeof type !== "string" || !REPORTS.has(type) || typeof alert !== "string" || !alert) return;
    try {
      opts.onReport?.(id, type as DeviceReport, alert);
    } catch (e) {
      console.error(`device-ws: [${id}] could not handle ${type}`, e);
    }
  });
  const end = () => {
    opts.links.remove(id, ws);
    console.log(`device-ws: [${id}] offline`);
  };
  ws.once("close", end);
  ws.on("error", () => ws.terminate());
}
