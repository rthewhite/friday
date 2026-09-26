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

export interface ConfigEntry {
  key: string;
  /** Declared secret by any module, or stored as secret. Secret entries never carry `value`. */
  secret: boolean;
  /** True when any requesting module requires the key. */
  required: boolean;
  description?: string;
  /** Modules that declare this key. Empty for undeclared global values. */
  modules: { id: string; required: boolean }[];
  status: "set" | "pending" | "env";
  scope?: string;
  updatedAt?: string;
  /** Current plain value (stored or environment). Absent for secrets and pending keys. */
  value?: string;
}

/** True when any module declares this key as a secret. */
export function isDeclaredSecret(host: ModuleHost, key: string): boolean {
  return host.manifests().some(({ manifest }) => manifest.config?.some((c) => c.key === key && c.secret === true));
}

/** One entry per key: declared keys aggregated across modules, then stored global values no module declares. */
export function configListing({ host, configStore, env = process.env }: Pick<AppDeps, "host" | "configStore" | "env">): ConfigEntry[] {
  const byKey = new Map<string, ConfigEntry>();
  for (const { manifest } of host.manifests()) {
    for (const c of manifest.config ?? []) {
      const e = byKey.get(c.key) ?? { key: c.key, secret: false, required: false, modules: [], status: "pending" as const };
      e.modules.push({ id: manifest.id, required: c.required === true });
      e.required ||= c.required === true;
      e.secret ||= c.secret === true;
      e.description ??= c.description;
      byKey.set(c.key, e);
    }
  }
  for (const e of byKey.values()) {
    // First requester whose scope (or global) has a stored value wins; otherwise env; otherwise pending.
    for (const m of e.modules) {
      const st = statusOf(configStore, env, m.id, e.key);
      if (st.status === "set") { Object.assign(e, st); break; }
      if (st.status === "env") e.status = "env";
    }
    if (e.scope) {
      e.secret ||= configStore?.info(e.scope, e.key)?.secret === true;
      e.updatedAt = configStore?.updatedAt(e.scope, e.key);
    }
    if (!e.secret && e.status !== "pending") {
      const value = e.scope ? configStore?.get(e.scope, e.key) : env[e.key];
      if (value !== undefined) e.value = value;
    }
  }
  for (const { scope, key, secret, updatedAt } of configStore?.keys() ?? []) {
    if (scope !== GLOBAL_SCOPE || byKey.has(key)) continue;
    const e: ConfigEntry = { key, secret, required: false, modules: [], status: "set", scope: GLOBAL_SCOPE, updatedAt };
    if (!secret) { const v = configStore?.get(GLOBAL_SCOPE, key); if (v !== undefined) e.value = v; }
    byKey.set(key, e);
  }
  return [...byKey.values()];
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
    .add("GET", "/api/config", (_req, res) => sendJson(res, { secretsEnabled: deps.configStore?.secretsEnabled === true, entries: configListing(deps) }))
    .add("PUT", "/api/config/:scope/:key", async (req, res, { scope, key }) => {
      if (!deps.configStore) return sendJson(res, { error: "no configuration store" }, 503);
      if (scope !== GLOBAL_SCOPE && !deps.host.manifests().some((m) => m.manifest.id === scope)) return sendJson(res, { error: `unknown scope "${scope}"` }, 404);
      let body: { value?: unknown; secret?: unknown };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, { error: "invalid JSON" }, 400);
      }
      if (typeof body.value !== "string" || !body.value) return sendJson(res, { error: "value must be a non-empty string" }, 400);
      // A key any module declares secret is always stored encrypted; the request cannot downgrade it.
      const secret = isDeclaredSecret(deps.host, key) || body.secret === true;
      try {
        deps.configStore.set(scope, key, body.value, { secret });
      } catch (e) {
        if (e instanceof ConfigStoreDisabled) return sendJson(res, { error: e.message }, 503);
        throw e;
      }
      res.statusCode = 204;
      res.end();
    })
    .add("DELETE", "/api/config/:scope/:key", (_req, res, { scope, key }) => {
      if (!deps.configStore) return sendJson(res, { error: "no configuration store" }, 503);
      deps.configStore.delete(scope, key);
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
