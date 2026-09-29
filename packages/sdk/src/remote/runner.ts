/**
 * Run a FridayModule as a remote: connect to core's /ws/modules, authenticate,
 * and serve the module's tools over MCP on the socket. Reconnects with backoff.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { assertConfig, createContext, type Env } from "../context.js";
import type { FridayModule, ModuleLogger } from "../module.js";
import { ToolRegistry } from "../registry.js";
import type { Tool } from "../tool.js";
import { toJsonSchema } from "./json-schema.js";
import { NO_RETRY_CODES, REMOTE_PROTOCOL, SCHEDULING_META, type HelloMessage, type WelcomeMessage } from "./protocol.js";
import { WsTransport } from "./transport.js";

export interface RemoteOptions {
  /** ws(s)://host/ws/modules */
  url: string;
  key: string;
  /** Configuration source for the module; defaults to process.env. */
  env?: Env;
  log?: ModuleLogger;
  /** Backoff bounds in ms (default 1000 to 30000). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long to wait for `welcome` before giving up on a connection attempt (default 5000). */
  helloTimeoutMs?: number;
}

export interface RemoteHandle {
  stop(): Promise<void>;
  /** Resolves when the current connection has been welcomed (mainly for tests). */
  connected(): Promise<void>;
}

export function runRemote(module: FridayModule, opts: RemoteOptions): RemoteHandle {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console;
  const min = opts.minBackoffMs ?? 1000;
  const max = opts.maxBackoffMs ?? 30000;
  const registry = new ToolRegistry(log);
  let stopped = false;
  let ws: WebSocket | undefined;
  let backoff = min;
  let wake: (() => void) | undefined;
  let connectedResolve: (() => void) | undefined;
  let connectedPromise = new Promise<void>((r) => (connectedResolve = r));

  const ready = (async () => {
    assertConfig(module.manifest, env);
    const migrations = module.migrations?.length ?? 0;
    if (migrations) log.warn(`remote ${module.manifest.id}: ignoring ${migrations} declared migration(s); remote modules have no database`);
    await module.init(createContext(module.manifest, { env, registry, log }));
  })();

  const loop = async () => {
    await ready;
    while (!stopped) {
      const code = await attempt();
      if (stopped) break;
      if (NO_RETRY_CODES.includes(code)) {
        log.error(`remote ${module.manifest.id}: rejected by core (${code}), not retrying`);
        break;
      }
      const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
      log.warn(`remote ${module.manifest.id}: disconnected (${code}), reconnecting in ${delay} ms`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, delay);
      });
      backoff = Math.min(max, backoff * 2);
    }
  };

  /** One connection lifetime; resolves with the close code. */
  const attempt = (): Promise<number> =>
    new Promise<number>((resolve) => {
      const sock = new WebSocket(opts.url);
      ws = sock;
      let welcomed = false;
      const helloTimer = setTimeout(() => sock.close(4000, "no welcome"), opts.helloTimeoutMs ?? 5000);

      sock.on("open", () => {
        const hello: HelloMessage = { type: "hello", key: opts.key, manifest: module.manifest, protocol: REMOTE_PROTOCOL };
        sock.send(JSON.stringify(hello));
      });
      sock.once("message", (raw) => {
        let msg: WelcomeMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return sock.close(4000, "bad welcome");
        }
        if (msg.type !== "welcome") return sock.close(4000, "expected welcome");
        clearTimeout(helloTimer);
        welcomed = true;
        backoff = min;
        log.log(`remote ${module.manifest.id}: connected to ${opts.url}`);
        void serve(sock);
        connectedResolve?.();
      });
      sock.on("error", (e) => log.error(`remote ${module.manifest.id}: ${e.message}`));
      sock.on("close", (code) => {
        clearTimeout(helloTimer);
        if (welcomed) connectedPromise = new Promise<void>((r) => (connectedResolve = r));
        resolve(code);
      });
    });

  const serve = async (sock: WebSocket) => {
    const server = new Server({ name: module.manifest.id, version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.names().map((n) => describe(registry, n)) }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const { result, scheduling, endConversation } = await registry.callTool(params.name, params.arguments);
      const structured: Record<string, unknown> = { ...result, scheduling };
      if (endConversation !== undefined) structured.endConversation = endConversation;
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: "error" in result && Object.keys(result).length === 1 };
    });
    const unsub = registry.onChange(() => void server.sendToolListChanged().catch(() => {}));
    sock.once("close", unsub);
    await server.connect(new WsTransport(sock));
  };

  void loop();

  return {
    async stop() {
      stopped = true;
      wake?.();
      ws?.close(1000, "stopped");
      await ready.catch(() => {});
      await module.dispose?.();
    },
    connected: () => connectedPromise,
  };
}

function describe(registry: ToolRegistry, name: string) {
  const t = registry.get(name) as Tool;
  return {
    name,
    description: t.description,
    inputSchema: (t.parametersJsonSchema as Record<string, unknown> | undefined) ?? toJsonSchema(t.parameters),
    _meta: { [SCHEDULING_META]: t.scheduling ?? "INTERRUPT" },
  };
}
