/**
 * MCP `Transport` over a `ws` WebSocket: one JSON-RPC message per text frame. Used on both ends.
 * Frames that arrive between construction and `start()` are buffered, so a peer may construct
 * the transport in its welcome handler and connect a moment later without losing the first request.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { WebSocket } from "ws";

export class WsTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private started = false;
  private pending: string[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      if (this.started) this.dispatch(raw.toString());
      else this.pending.push(raw.toString());
    });
    ws.on("close", () => this.onclose?.());
    ws.on("error", (e) => this.onerror?.(e));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const m of this.pending.splice(0)) this.dispatch(m);
  }

  private dispatch(text: string): void {
    try {
      this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(text)));
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== this.ws.OPEN) throw new Error("websocket is not open");
    await new Promise<void>((resolve, reject) => this.ws.send(JSON.stringify(message), (e) => (e ? reject(e) : resolve())));
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}
