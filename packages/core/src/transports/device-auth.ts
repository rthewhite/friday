/**
 * Device authentication shared by `/ws/audio?device=` and `/ws/device`, so both decide exactly alike: the key comes
 * from `Authorization: Bearer <key>` (never the query string), a rejected connection is closed at once with the
 * store's code (4400, 4401, 4403, recording pending attempts), and a store error closes with 1011.
 */
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { AuthResult, DeviceSnapshot, DeviceStore } from "../devices/store.js";

const UNAUTHORIZED: AuthResult = { ok: false, code: 4401, reason: "unauthorized" };

/** The key from `Authorization: Bearer <key>`, or undefined. A key in the query string is never read. */
export function bearerKey(req: IncomingMessage | undefined): string | undefined {
  return /^Bearer\s+(\S+)\s*$/i.exec(req?.headers.authorization ?? "")?.[1];
}

/**
 * Check the device `claimed` connecting on `ws`. Returns its snapshot when accepted; otherwise the socket is already
 * being closed and undefined is returned. Without a store every device is unauthorized. `log` prefixes the log lines.
 */
export function authenticateDevice(
  ws: Pick<WebSocket, "close">,
  req: IncomingMessage | undefined,
  devices: Pick<DeviceStore, "authenticate"> | undefined,
  claimed: string,
  log = "ws",
): DeviceSnapshot | undefined {
  const tag = JSON.stringify(claimed.slice(0, 64));
  let auth: AuthResult;
  try {
    auth = devices?.authenticate(claimed, bearerKey(req)) ?? UNAUTHORIZED;
  } catch (e) {
    // Handlers run unawaited: a store error (a locked or full database) must close this socket, not the process.
    console.error(`${log}: [${tag}] could not check the device`, e);
    ws.close(1011, "internal error");
    return undefined;
  }
  if (!auth.ok) {
    // Frames sent before the close are dropped: no message handler is attached.
    console.log(`${log}: [${tag}] rejected: ${auth.code} ${auth.reason}`);
    ws.close(auth.code, auth.reason);
    return undefined;
  }
  return auth.device;
}
