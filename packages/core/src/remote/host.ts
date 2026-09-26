/**
 * Remote module host: `/ws/modules`. A remote sends `hello` {key, manifest,
 * protocol}, gets `welcome`, and from then on serves MCP over the same socket.
 * Its tools live in the registry (owner `remote:<id>`, name `<id>__<tool>`)
 * exactly as long as the connection does.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, ErrorCode, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WebSocketServer, WebSocket } from "ws";
import {
  CloseCode,
  REMOTE_PROTOCOL,
  SCHEDULING_META,
  WsTransport,
  type HelloMessage,
  type WelcomeMessage,
} from "@friday/sdk/remote";
import { SCHEDULINGS, validateManifest, type ModuleManifest, type Scheduling, type ToolRegistry } from "@friday/sdk";
import { prefixedName, toResult } from "../tools/mcp-shared.js";
import { keepAlive } from "../transports/keep-alive.js";
import { mountWs } from "../transports/mount.js";
import type { KeyStore } from "./key-store.js";

export const remoteOwner = (id: string) => `remote:${id}`;

export interface RemoteHostOptions {
  registry: ToolRegistry;
  keys: KeyStore;
  path?: string;
  pingMs?: number;
  helloTimeoutMs?: number;
  callTimeoutMs?: number;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export interface RemoteEntry {
  id: string;
  label: string;
  description?: string;
  status: "connected";
  tools: string[];
  connectedAt: string;
}

interface Connection {
  manifest: ModuleManifest;
  ws: WebSocket;
  client: Client;
  connectedAt: Date;
}

export class RemoteHost {
  private readonly connections = new Map<string, Connection>();
  private readonly log: Pick<Console, "log" | "warn" | "error">;
  private wss?: WebSocketServer;

  constructor(private readonly opts: RemoteHostOptions) {
    this.log = opts.log ?? console;
    if (opts.keys.isEmpty()) this.log.warn("remote modules disabled: FRIDAY_MODULE_KEYS is not set");
  }

  attach(server: HttpServer): WebSocketServer {
    const wss = mountWs(server, this.opts.path ?? "/ws/modules");
    keepAlive(wss, this.opts.pingMs ?? 20000, this.log);
    wss.on("connection", (ws, req) => void this.handshake(ws, req));
    this.wss = wss;
    return wss;
  }

  connected(): RemoteEntry[] {
    return [...this.connections.values()].map(({ manifest, connectedAt }) => ({
      id: manifest.id,
      label: manifest.label,
      description: manifest.description,
      status: "connected",
      tools: this.opts.registry.names(remoteOwner(manifest.id)),
      connectedAt: connectedAt.toISOString(),
    }));
  }

  /** Shutdown: tell every remote to come back later. */
  async closeAll(): Promise<void> {
    for (const c of this.connections.values()) c.ws.close(CloseCode.GOING_AWAY, "shutting down");
    this.wss?.close();
  }

  private async handshake(ws: WebSocket, _req: IncomingMessage): Promise<void> {
    const timer = setTimeout(() => ws.close(CloseCode.HELLO_TIMEOUT, "no hello"), this.opts.helloTimeoutMs ?? 5000);
    ws.once("message", async (raw, isBinary) => {
      clearTimeout(timer);
      let hello: HelloMessage;
      try {
        if (isBinary) throw new Error("binary");
        hello = JSON.parse(raw.toString());
        if (hello?.type !== "hello" || typeof hello.key !== "string") throw new Error("not a hello");
        if (hello.protocol !== REMOTE_PROTOCOL) throw new Error(`protocol ${hello.protocol}`);
        validateManifest(hello.manifest);
      } catch (e) {
        this.log.warn(`remote: bad hello (${e instanceof Error ? e.message : e})`);
        return ws.close(CloseCode.BAD_REQUEST, "bad hello");
      }
      const id = await this.opts.keys.lookup(hello.key);
      if (!id || id !== hello.manifest.id) {
        this.log.warn(`remote: unauthorized hello for "${hello.manifest.id}"`);
        return ws.close(CloseCode.UNAUTHORIZED, "unauthorized");
      }
      await this.accept(ws, hello.manifest);
    });
  }

  private async accept(ws: WebSocket, manifest: ModuleManifest): Promise<void> {
    const id = manifest.id;
    const old = this.connections.get(id);
    if (old) {
      this.log.log(`remote ${id}: replaced by a new connection`);
      this.drop(old, CloseCode.REPLACED, "replaced");
    }

    const client = new Client({ name: "friday", version: "0.1.0" });
    const conn: Connection = { manifest, ws, client, connectedAt: new Date() };
    this.connections.set(id, conn);
    ws.on("close", (code) => {
      if (this.connections.get(id) !== conn) return; // already replaced
      this.connections.delete(id);
      const n = this.opts.registry.removeOwner(remoteOwner(id));
      this.log.log(`remote ${id}: disconnected (${code}), ${n} tools removed`);
    });

    const welcome: WelcomeMessage = { type: "welcome", id };
    ws.send(JSON.stringify(welcome));
    try {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.register(conn).catch((e) => this.log.error(`remote ${id}: re-list failed`, e)));
      await client.connect(new WsTransport(ws));
      await this.register(conn);
    } catch (e) {
      this.log.error(`remote ${id}: setup failed`, e);
      this.drop(conn, CloseCode.BAD_REQUEST, "mcp setup failed");
    }
  }

  private drop(conn: Connection, code: number, reason: string): void {
    if (this.connections.get(conn.manifest.id) === conn) this.connections.delete(conn.manifest.id);
    this.opts.registry.removeOwner(remoteOwner(conn.manifest.id));
    conn.ws.close(code, reason);
  }

  private async register(conn: Connection): Promise<void> {
    const id = conn.manifest.id;
    const { tools } = await conn.client.listTools();
    if (this.connections.get(id) !== conn) return;
    this.opts.registry.removeOwner(remoteOwner(id));
    for (const t of tools) {
      const meta = (t._meta as Record<string, unknown> | undefined)?.[SCHEDULING_META];
      this.opts.registry.add(remoteOwner(id), {
        name: prefixedName(id, t.name),
        description: t.description ?? t.name,
        parametersJsonSchema: t.inputSchema,
        scheduling: SCHEDULINGS.includes(meta as Scheduling) ? (meta as Scheduling) : "INTERRUPT",
        handler: async (args: Record<string, unknown>) => {
          try {
            return toResult(await conn.client.callTool({ name: t.name, arguments: args }, undefined, { timeout: this.opts.callTimeoutMs ?? 10000 }));
          } catch (e) {
            if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return { error: "timeout" };
            throw e;
          }
        },
      });
    }
    this.log.log(`remote ${id}: ${tools.length} tools registered`);
  }
}
