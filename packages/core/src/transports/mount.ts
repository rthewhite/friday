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

const routers = new WeakMap<Server, Map<string, { wss: WebSocketServer; verify?: VerifyUpgrade }>>();

const REASONS: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 500: "Internal Server Error" };

function refuse(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${REASONS[status] ?? "Refused"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function mountWs(server: Server, path: string, opts: Omit<ServerOptions, "server" | "noServer" | "path"> = {}, verify?: VerifyUpgrade): WebSocketServer {
  let routes = routers.get(server);
  if (!routes) {
    routes = new Map();
    routers.set(server, routes);
    const table = routes;
    server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
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
    });
  }
  if (routes.has(path)) throw new Error(`websocket path ${path} already mounted`);
  const wss = new WebSocketServer({ ...opts, noServer: true });
  routes.set(path, { wss, verify });
  wss.on("close", () => routes!.delete(path));
  return wss;
}
