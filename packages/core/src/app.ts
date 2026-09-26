/** HTTP request handler: health, tool and module APIs, module routes, and the portal (SPA). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ToolRegistry } from "@friday/sdk";
import type { ModuleEntry, ModuleHost } from "./module-host.js";
import { mcpOwner, type McpSource } from "./tools/mcp.js";
import type { RemoteEntry, RemoteHost } from "./remote/host.js";
import { adaptRequest, adaptResponse, readBody, Router, sendJson } from "./router.js";
import { ConfigStoreDisabled, GLOBAL_SCOPE, type ConfigStore } from "./secrets/config-store.js";
import { statusOf } from "./secrets/resolver.js";
import type { SqliteKeyStore } from "./remote/key-store.js";
import type { Env } from "@friday/sdk";

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
  /** Platform services; optional so tests can build a minimal app. */
  configStore?: ConfigStore;
  keys?: SqliteKeyStore;
  env?: Env;
}

export interface ConfigEntry {
  module: string;
  key: string;
  required: boolean;
  description?: string;
  status: "set" | "pending" | "env";
  scope?: string;
}

/** Declared keys per module, plus stored global values that no module declares. */
export function configListing({ host, configStore, env = process.env }: Pick<AppDeps, "host" | "configStore" | "env">): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  const declared = new Set<string>();
  for (const { manifest } of host.manifests()) {
    for (const c of manifest.config ?? []) {
      declared.add(c.key);
      out.push({ module: manifest.id, key: c.key, required: c.required === true, description: c.description, ...statusOf(configStore, env, manifest.id, c.key) });
    }
  }
  for (const { scope, key } of configStore?.keys() ?? []) {
    if (scope === GLOBAL_SCOPE && !declared.has(key)) out.push({ module: GLOBAL_SCOPE, key, required: false, status: "set", scope: GLOBAL_SCOPE });
  }
  return out;
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
    .add("GET", "/api/modules", (_req, res) => sendJson(res, moduleListing(deps)))
    .add("POST", "/api/modules/:id/reload", async (_req, res, { id }) => {
      const entry = await deps.host.reload(id);
      if (!entry) return sendJson(res, { error: `no reloadable in-process module "${id}"` }, 404);
      sendJson(res, entry);
    })
    .add("GET", "/api/config", (_req, res) => sendJson(res, { enabled: deps.configStore?.enabled === true, entries: configListing(deps) }))
    .add("PUT", "/api/config/:scope/:key", async (req, res, { scope, key }) => {
      if (!deps.configStore) return sendJson(res, { error: "no configuration store" }, 503);
      if (scope !== GLOBAL_SCOPE && !deps.host.manifests().some((m) => m.manifest.id === scope)) return sendJson(res, { error: `unknown scope "${scope}"` }, 404);
      let body: { value?: unknown };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, { error: "invalid JSON" }, 400);
      }
      if (typeof body.value !== "string" || !body.value) return sendJson(res, { error: "value must be a non-empty string" }, 400);
      try {
        deps.configStore.set(scope, key, body.value);
      } catch (e) {
        if (e instanceof ConfigStoreDisabled) return sendJson(res, { error: e.message }, 503);
        throw e;
      }
      res.statusCode = 204;
      res.end();
    })
    .add("DELETE", "/api/config/:scope/:key", (_req, res, { scope, key }) => {
      if (!deps.configStore) return sendJson(res, { error: "no configuration store" }, 503);
      try {
        deps.configStore.delete(scope, key);
      } catch (e) {
        if (e instanceof ConfigStoreDisabled) return sendJson(res, { error: e.message }, 503);
        throw e;
      }
      res.statusCode = 204;
      res.end();
    })
    .add("GET", "/api/keys", (_req, res) => sendJson(res, deps.keys?.list() ?? []))
    .add("POST", "/api/keys", async (req, res) => {
      if (!deps.keys) return sendJson(res, { error: "no key store" }, 503);
      let body: { moduleId?: unknown; label?: unknown };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, { error: "invalid JSON" }, 400);
      }
      if (typeof body.moduleId !== "string" || !/^[a-z][a-z0-9-]*$/.test(body.moduleId)) return sendJson(res, { error: "moduleId must be a kebab-case id" }, 400);
      const { record, key } = deps.keys.create(body.moduleId, typeof body.label === "string" && body.label ? body.label : body.moduleId);
      sendJson(res, { ...record, key }, 201);
    })
    .add("DELETE", "/api/keys/:id", (_req, res, { id }) => {
      if (!deps.keys) return sendJson(res, { error: "no key store" }, 503);
      const moduleId = deps.keys.revoke(id);
      if (!moduleId) return sendJson(res, { error: "unknown or already revoked key" }, 404);
      // A live connection authenticated with a stored key loses access immediately. Env-key
      // connections for the same id are indistinguishable here and are closed too; they reconnect.
      deps.remote?.disconnect(moduleId);
      res.statusCode = 204;
      res.end();
    });

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
