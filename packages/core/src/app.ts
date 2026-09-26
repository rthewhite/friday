/** HTTP request handler: health, tool and module APIs, module routes, and the portal (SPA). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ToolRegistry } from "@friday/sdk";
import type { ModuleEntry, ModuleHost } from "./module-host.js";
import { mcpOwner, type McpSource } from "./tools/mcp.js";
import type { RemoteEntry, RemoteHost } from "./remote/host.js";
import { adaptRequest, adaptResponse, Router, sendJson } from "./router.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Paths that must never fall back to index.html. */
const RESERVED = ["/api", "/ws", "/health"];

export interface AppDeps {
  registry: ToolRegistry;
  host: ModuleHost;
  mcp: McpSource;
  remote?: RemoteHost;
  webDir: string;
}

export type ApiModuleEntry = ModuleEntry | RemoteEntry;

/** In-process modules, then MCP servers, then connected remotes: the shape /api/modules returns. */
export function moduleListing({ host, mcp, registry, remote }: Pick<AppDeps, "host" | "mcp" | "registry" | "remote">): ApiModuleEntry[] {
  return [
    ...host.loaded(),
    ...mcp.servers().map((name) => ({
      id: mcpOwner(name),
      label: name,
      description: "MCP server",
      status: "loaded" as const,
      tools: registry.names(mcpOwner(name)),
      ui: false,
    })),
    ...(remote?.connected() ?? []),
  ];
}

export function createApp(deps: AppDeps) {
  const webRoot = resolve(deps.webDir);
  const router = new Router()
    .add("GET", "/health", (_req, res) => sendJson(res, { ok: true, tools: deps.registry.names().length }))
    .add("GET", "/api/tools", (_req, res) => sendJson(res, deps.registry.declarations()))
    .add("GET", "/api/modules", (_req, res) => sendJson(res, moduleListing(deps)));

  const moduleRoute = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const m = /^\/api\/modules\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return false;
    const table = deps.host.routesOf(decodeURIComponent(m[1]));
    const sub = m[2] || "/";
    const hit = table?.find(req.method ?? "GET", sub);
    if (!table || hit === null || hit === undefined) return false;
    if (hit === "method") {
      res.statusCode = 405;
      res.end("method not allowed");
      return true;
    }
    const out = adaptResponse(res);
    try {
      await hit.handler(adaptRequest(req, url, sub), out, hit.params);
      if (!out.sent) {
        res.statusCode = res.statusCode === 200 ? 204 : res.statusCode;
        res.end();
      }
    } catch (e) {
      console.error(`module route ${req.method} ${url.pathname} failed`, e);
      if (!out.sent) out.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (await router.dispatch(req, res, url)) return;
    if (await moduleRoute(req, res, url)) return;
    if (RESERVED.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
      res.statusCode = 404;
      return res.end("not found");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      return res.end("method not allowed");
    }

    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      res.statusCode = 400;
      return res.end("bad path");
    }
    const file = resolve(webRoot, path === "/" ? "index.html" : path.slice(1));
    if (!file.startsWith(webRoot + sep)) {
      res.statusCode = 400;
      return res.end("bad path");
    }
    if (await serveFile(res, file, /\/assets\//.test(file))) return;
    // SPA fallback: let the router render client-side routes such as /m/media.
    if (!extname(path) && (await serveFile(res, resolve(webRoot, "index.html"), false))) return;
    res.statusCode = 404;
    res.end("not found");
  };
}

async function serveFile(res: ServerResponse, file: string, immutable: boolean): Promise<boolean> {
  try {
    const body = await readFile(file);
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    res.end(body);
    return true;
  } catch {
    return false;
  }
}
