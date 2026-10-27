/**
 * Route HTTP upgrade requests to WebSocket servers by path. `ws` servers bound
 * directly to an http.Server each reject upgrades for other paths with 400, so
 * every endpoint mounts through this single dispatcher instead.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type ServerOptions } from "ws";

/**
 * Decides on an upgrade before the WebSocket opens: undefined accepts it, a status (401, 403) refuses it with that
 * HTTP response. A throw refuses it with 500.
 */
export type VerifyUpgrade = (req: IncomingMessage) => Promise<number | undefined> | number | undefined;

type Table = Map<string, { wss: WebSocketServer; verify?: VerifyUpgrade }>;

const routers = new WeakMap<Server, Table>();

const REASONS: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 500: "Internal Server Error" };

function refuse(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${REASONS[status] ?? "Refused"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function dispatch(table: Table, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    return refuse(socket, 400);
  }
  const route = table.get(pathname);
  if (!route) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (route.verify) {
    // The client may go away while the check runs; nothing else listens on the socket yet.
    const dropped = () => socket.destroy();
    socket.on("error", dropped);
    let status: number | undefined;
    try {
      status = await route.verify(req);
    } catch (e) {
      console.error(`ws: could not check the upgrade to ${pathname}`, e);
      status = 500;
    }
    socket.off("error", dropped);
    if (socket.destroyed) return;
    if (status !== undefined) return refuse(socket, status);
  }
  route.wss.handleUpgrade(req, socket, head, (ws) => route.wss.emit("connection", ws, req));
}

export function mountWs(server: Server, path: string, opts: Omit<ServerOptions, "server" | "noServer" | "path"> = {}, verify?: VerifyUpgrade): WebSocketServer {
  let routes = routers.get(server);
  if (!routes) {
    routes = new Map();
    routers.set(server, routes);
    const table = routes;
    // The listener is async (the check may wait on the login provider), so nothing may escape it: an unhandled
    // rejection would end the process, devices and remote modules included.
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      dispatch(table, req, socket, head).catch((e) => {
        console.error(`ws: upgrade of ${JSON.stringify(String(req.url).slice(0, 200))} failed`, e);
        socket.destroy();
      });
    });
  }
  if (routes.has(path)) throw new Error(`websocket path ${path} already mounted`);
  const wss = new WebSocketServer({ ...opts, noServer: true });
  routes.set(path, { wss, verify });
  wss.on("close", () => routes!.delete(path));
  return wss;
}
