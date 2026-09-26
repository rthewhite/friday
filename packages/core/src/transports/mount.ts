/**
 * Route HTTP upgrade requests to WebSocket servers by path. `ws` servers bound
 * directly to an http.Server each reject upgrades for other paths with 400, so
 * every endpoint mounts through this single dispatcher instead.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type ServerOptions } from "ws";

const routers = new WeakMap<Server, Map<string, WebSocketServer>>();

export function mountWs(server: Server, path: string, opts: Omit<ServerOptions, "server" | "noServer" | "path"> = {}): WebSocketServer {
  let routes = routers.get(server);
  if (!routes) {
    routes = new Map();
    routers.set(server, routes);
    const table = routes;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      const wss = table.get(pathname);
      if (!wss) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  }
  if (routes.has(path)) throw new Error(`websocket path ${path} already mounted`);
  const wss = new WebSocketServer({ ...opts, noServer: true });
  routes.set(path, wss);
  wss.on("close", () => routes!.delete(path));
  return wss;
}
