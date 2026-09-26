/**
 * Test host: run a module against an in-memory registry with no server, no
 * Gemini and no environment leakage. `import { createTestHost } from "@friday/sdk/test"`.
 */
import { assertConfig, createContext, type Env } from "./context.js";
import { RouteTable, type HttpMethod, type RouteRequest, type RouteResponse } from "./http.js";
import type { FridayModule, ModuleLogger } from "./module.js";
import { ToolRegistry, type CallResult } from "./registry.js";
import { MemoryStorage } from "./storage.js";

export interface TestHostOptions {
  /** Configuration the module sees. Defaults to an empty environment, not `process.env`. */
  env?: Env;
  /** Capture module log output; defaults to a silent logger. */
  log?: ModuleLogger;
}

export interface TestResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface TestHost {
  tools: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  registry: ToolRegistry;
  /** In-memory storage the module saw as `ctx.storage`. */
  storage: MemoryStorage;
  /** Registered module routes as `GET search`. */
  routes: string[];
  /** Invoke a module route in memory. `path` is relative to the module mount and may carry a query string. */
  request(method: HttpMethod, path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse>;
  dispose(): Promise<void>;
}

const silent: ModuleLogger = { log() {}, warn() {}, error() {} };

export async function createTestHost(module: FridayModule, opts: TestHostOptions = {}): Promise<TestHost> {
  const env = opts.env ?? {};
  const log = opts.log ?? silent;
  assertConfig(module.manifest, env);
  const registry = new ToolRegistry(log);
  const table = new RouteTable();
  const storage = new MemoryStorage();
  await module.init(createContext(module.manifest, { env, registry, log, storage, http: { route: (method, path, handler) => table.add({ method, path, handler }) } }));
  return {
    tools: registry.names(module.manifest.id),
    call: (name, args) => registry.callTool(name, args),
    registry,
    storage,
    routes: table.list().map((r) => `${r.method} ${r.path.replace(/^\//, "")}`),
    async request(method, pathWithQuery, body, headers = {}) {
      const [path, qs = ""] = pathWithQuery.split("?");
      const hit = table.find(method, path);
      if (hit === null) return { status: 404, body: { error: "not found" } };
      if (hit === "method") return { status: 405, body: { error: "method not allowed" } };
      const req: RouteRequest = {
        method,
        path,
        query: new URLSearchParams(qs),
        headers,
        json: async <T,>() => body as T,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
      };
      const out: TestResponse = { status: 200, body: undefined };
      let sent = false;
      const res: RouteResponse = {
        get sent() { return sent; },
        status(code) { out.status = code; return res; },
        json(b) { sent = true; out.body = b; out.contentType = "application/json"; },
        text(b, ct = "text/plain") { sent = true; out.body = b; out.contentType = ct; },
      };
      await hit.handler(req, res, hit.params);
      if (!sent) out.status = 204;
      return out;
    },
    dispose: async () => void (await module.dispose?.()),
  };
}
