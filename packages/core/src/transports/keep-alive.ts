import type { WebSocketServer, WebSocket } from "ws";

/**
 * Ping every client of `wss` each `pingMs` and terminate those that did not
 * answer the previous ping. Client pings are answered by `ws` automatically.
 * Returns a stop function; 0 disables and returns a no-op.
 */
export function keepAlive(wss: WebSocketServer, pingMs: number, log: Pick<Console, "log"> = console): () => void {
  if (pingMs <= 0) return () => {};
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        log.log("ws: no pong, terminating");
        ws.terminate(); // fires "close" on the socket
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, pingMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  wss.on("close", stop);
  return stop;
}
