/** HTTP request handler: health, tool and module APIs, static web client. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ToolRegistry } from "@friday/sdk";
import type { ModuleEntry, ModuleHost } from "./module-host.js";
import { mcpOwner, type McpSource } from "./tools/mcp.js";
import type { RemoteEntry, RemoteHost } from "./remote/host.js";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

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
    })),
    ...(remote?.connected() ?? []),
  ];
}

export function createApp(deps: AppDeps) {
  const webRoot = resolve(deps.webDir);
  const json = (res: ServerResponse, body: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return json(res, { ok: true, tools: deps.registry.names().length });
    if (url.pathname === "/api/tools") return json(res, deps.registry.declarations());
    if (url.pathname === "/api/modules") return json(res, moduleListing(deps));

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
    try {
      const body = await readFile(file);
      res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  };
}

