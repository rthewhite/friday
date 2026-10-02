/** HTTP request handler: health, tool and module APIs, module routes, and the portal (SPA). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ConversationChannel, ToolRegistry } from "@friday/sdk";
import type { ModuleEntry, ModuleHost } from "./module-host.js";
import { mcpOwner, type McpSource } from "./tools/mcp.js";
import { McpInputError, McpServerExists, McpStoreDisabled, parseServerInput, type McpServerStore, type StoredServer } from "./tools/mcp-store.js";
import type { RemoteEntry, RemoteHost } from "./remote/host.js";
import { adaptRequest, adaptResponse, readBody, Router, sendJson } from "./router.js";
import { ConfigStoreDisabled, GLOBAL_SCOPE, type ConfigStore } from "./secrets/config-store.js";
import { statusOf } from "./secrets/resolver.js";
import type { SqliteKeyStore } from "./remote/key-store.js";
import { DeviceConflict, DeviceInputError, DeviceNotFound, type Device, type DeviceStore } from "./devices/store.js";
import type { DeviceSessions } from "./devices/sessions.js";
import type { Scheduler } from "./jobs/scheduler.js";
import { cursorOf, DEFAULT_LIST_LIMIT, InvalidQuery, type ConversationStore } from "./conversations/store.js";
import type { Env } from "@friday/sdk";
import { CORE_ID, coreManifest } from "./core-config.js";
import type { ChatEngine } from "./chat/engine.js";
import { chatRoute } from "./chat/route.js";

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
  /** MCP server definitions; without it the MCP server API answers 503. */
  mcpStore?: McpServerStore;
  remote?: RemoteHost;
  webDir: string;
  /** Platform services; optional so tests can build a minimal app. */
  configStore?: ConfigStore;
  keys?: SqliteKeyStore;
  /** Voice devices; without it `/api/devices` answers 503. */
  devices?: DeviceStore;
  /** Open device connections, for `connected` and for closing them on revoke, delete and key replacement. */
  deviceSessions?: DeviceSessions;
  env?: Env;
  jobs?: Scheduler;
  conversations?: ConversationStore;
  /** Portal chat; without it `POST /api/chat` answers 503. */
  chat?: ChatEngine;
  /** Interval of the chat stream's keep-alive comments (tests shorten it). */
  chatHeartbeatMs?: number;
  /** Called after a configuration value is stored or deleted through the API. */
  onConfigChange?: (scope: string, key: string) => void;
}

export type ApiModuleEntry = ModuleEntry | RemoteEntry;

/** In-process modules, then MCP servers, then connected remotes: the shape /api/modules returns. */
export function moduleListing({ host, mcp, remote }: Pick<AppDeps, "host" | "mcp" | "remote">): ApiModuleEntry[] {
  return [
    ...host.loaded(),
    ...mcp.servers().map(({ name, status, error, tools }): ModuleEntry => ({
      id: mcpOwner(name),
      label: name,
      description: "MCP server",
      status,
      ...(error ? { error } : {}),
      tools,
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
  /** Every scope the key is stored in (global, core, then by name), so overrides are visible. Absent when none. */
  stored?: StoredScope[];
}

export interface StoredScope {
  scope: string;
  updatedAt: string;
  /** Plain values only. */
  value?: string;
}

const scopeOrder = (s: string) => (s === GLOBAL_SCOPE ? 0 : s === CORE_ID ? 1 : 2);

/** Everything that declares configuration: core itself, then every known module. */
const requesters = (host: ModuleHost) => [{ manifest: coreManifest }, ...host.manifests()];

/** True when core or any module declares this key as a secret. */
export function isDeclaredSecret(host: ModuleHost, key: string): boolean {
  return requesters(host).some(({ manifest }) => manifest.config?.some((c) => c.key === key && c.secret === true));
}

/** One entry per key: declared keys aggregated across core and modules, then stored global values nothing declares. */
export function configListing({ host, configStore, env = process.env }: Pick<AppDeps, "host" | "configStore" | "env">): ConfigEntry[] {
  const byKey = new Map<string, ConfigEntry>();
  for (const { manifest } of requesters(host)) {
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
  const rows = configStore?.keys() ?? [];
  for (const { scope, key, secret, updatedAt } of rows) {
    if (scope !== GLOBAL_SCOPE || byKey.has(key)) continue;
    const e: ConfigEntry = { key, secret, required: false, modules: [], status: "set", scope: GLOBAL_SCOPE, updatedAt };
    if (!secret) { const v = configStore?.get(GLOBAL_SCOPE, key); if (v !== undefined) e.value = v; }
    byKey.set(key, e);
  }
  // Every stored copy, including scopes no loaded module declares (leftovers worth clearing).
  for (const row of rows) {
    const e = byKey.get(row.key);
    if (!e) continue;
    const s: StoredScope = { scope: row.scope, updatedAt: row.updatedAt };
    if (!row.secret && !e.secret) {
      const v = configStore?.get(row.scope, row.key);
      if (v !== undefined) s.value = v;
    }
    (e.stored ??= []).push(s);
  }
  for (const e of byKey.values()) e.stored?.sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope) || a.scope.localeCompare(b.scope));
  return [...byKey.values()];
}

/** The write is already committed, so a failing listener is logged rather than turning the save into a 500. */
function notifyConfigChange({ onConfigChange }: Pick<AppDeps, "onConfigChange">, scope: string, key: string): void {
  try {
    onConfigChange?.(scope, key);
  } catch (e) {
    console.error(`config: reacting to ${scope}/${key} failed`, e);
  }
}

/** A stored definition (secret entries without values) merged with its connection state. */
function mcpServerEntry({ mcp }: Pick<AppDeps, "mcp">, s: StoredServer) {
  const state = mcp.stateOf(s.name) ?? (s.enabled ? { status: "failed" as const, error: "not connected", tools: [] } : { status: "disabled" as const, tools: [] });
  return { ...s, status: state.status, ...(state.error ? { error: state.error } : {}), tools: state.tools };
}

/** Parse the JSON body and map MCP store errors to 400 / 409 / 503. */
async function mcpWrite(deps: AppDeps, req: IncomingMessage, res: ServerResponse, fn: (store: McpServerStore, body: unknown) => Promise<void>): Promise<void> {
  if (!deps.mcpStore) return sendJson(res, { error: "no MCP server store" }, 503);
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, { error: "invalid JSON" }, 400);
  }
  try {
    await fn(deps.mcpStore, body);
  } catch (e) {
    if (e instanceof McpInputError) return sendJson(res, { error: e.message }, 400);
    if (e instanceof McpServerExists) return sendJson(res, { error: e.message }, 409);
    if (e instanceof McpStoreDisabled) return sendJson(res, { error: e.message }, 503);
    throw e;
  }
}

const withConnected = (deps: AppDeps, d: Device) => ({ ...d, connected: deps.deviceSessions?.connected(d.id) ?? false });

/** Run a voice device route: 503 without a store, the body parsed when `withBody`, store errors as 400/404/409. */
async function deviceRoute(
  deps: AppDeps,
  req: IncomingMessage,
  res: ServerResponse,
  withBody: boolean,
  fn: (store: DeviceStore, body: Record<string, unknown>) => void,
): Promise<void> {
  if (!deps.devices) return sendJson(res, { error: "no device store" }, 503);
  let body: Record<string, unknown> = {};
  if (withBody) {
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return sendJson(res, { error: "invalid JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, { error: "body must be a JSON object" }, 400);
  }
  try {
    fn(deps.devices, body);
  } catch (e) {
    if (e instanceof DeviceInputError) return sendJson(res, { error: e.message }, 400);
    if (e instanceof DeviceNotFound) return sendJson(res, { error: e.message }, 404);
    if (e instanceof DeviceConflict) return sendJson(res, { error: e.message }, 409);
    throw e;
  }
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
      if (scope !== GLOBAL_SCOPE && scope !== CORE_ID && !deps.host.manifests().some((m) => m.manifest.id === scope)) return sendJson(res, { error: `unknown scope "${scope}"` }, 404);
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
      notifyConfigChange(deps, scope, key);
      res.statusCode = 204;
      res.end();
    })
    .add("DELETE", "/api/config/:scope/:key", (_req, res, { scope, key }) => {
      if (!deps.configStore) return sendJson(res, { error: "no configuration store" }, 503);
      deps.configStore.delete(scope, key);
      notifyConfigChange(deps, scope, key);
      res.statusCode = 204;
      res.end();
    })
    .add("GET", "/api/mcp/servers", (_req, res) => {
      const store = deps.mcpStore;
      sendJson(res, { secretsEnabled: store?.secretsEnabled === true, servers: store?.list().map((s) => mcpServerEntry(deps, s)) ?? [] });
    })
    .add("POST", "/api/mcp/servers", (req, res) =>
      mcpWrite(deps, req, res, async (store, body) => {
        const created = store.create(parseServerInput(body));
        await deps.mcp.apply(created.name);
        sendJson(res, mcpServerEntry(deps, store.get(created.name)!), 201);
      }),
    )
    .add("PUT", "/api/mcp/servers/:name", (req, res, { name }) =>
      mcpWrite(deps, req, res, async (store, body) => {
        if (!store.get(name)) return sendJson(res, { error: `unknown MCP server "${name}"` }, 404);
        store.update(parseServerInput(body, name));
        await deps.mcp.apply(name);
        sendJson(res, mcpServerEntry(deps, store.get(name)!));
      }),
    )
    .add("DELETE", "/api/mcp/servers/:name", async (_req, res, { name }) => {
      if (!deps.mcpStore) return sendJson(res, { error: "no MCP server store" }, 503);
      if (!deps.mcpStore.delete(name)) return sendJson(res, { error: `unknown MCP server "${name}"` }, 404);
      await deps.mcp.apply(name);
      res.statusCode = 204;
      res.end();
    })
    .add("POST", "/api/mcp/servers/:name/reconnect", async (_req, res, { name }) => {
      if (!deps.mcpStore) return sendJson(res, { error: "no MCP server store" }, 503);
      if (!deps.mcpStore.get(name)) return sendJson(res, { error: `unknown MCP server "${name}"` }, 404);
      await deps.mcp.apply(name);
      sendJson(res, mcpServerEntry(deps, deps.mcpStore.get(name)!));
    })
    .add("POST", "/api/chat", chatRoute(deps.chat, { heartbeatMs: deps.chatHeartbeatMs }))
    .add("GET", "/api/conversations", (_req, res, _params, url) => {
      if (!deps.conversations) return sendJson(res, { conversations: [], next: null });
      const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit") ?? DEFAULT_LIST_LIMIT)) || DEFAULT_LIST_LIMIT, 1), 200);
      try {
        // One extra row tells whether there is a next page.
        const channel = url.searchParams.get("channel") || undefined;
        const rows = deps.conversations.list({ limit: limit + 1, before: url.searchParams.get("before") || undefined, channel: channel as ConversationChannel | undefined });
        const page = rows.slice(0, limit);
        sendJson(res, { conversations: page, next: rows.length > limit ? cursorOf(page[page.length - 1]) : null });
      } catch (e) {
        if (e instanceof InvalidQuery) return sendJson(res, { error: e.message }, 400);
        throw e;
      }
    })
    .add("GET", "/api/conversations/:id", (_req, res, { id }) => {
      const c = deps.conversations?.get(id);
      if (!c) return sendJson(res, { error: "unknown conversation" }, 404);
      sendJson(res, c);
    })
    .add("DELETE", "/api/conversations/:id", (_req, res, { id }) => {
      const outcome = deps.conversations?.delete(id) ?? "missing";
      if (outcome === "missing") return sendJson(res, { error: "unknown conversation" }, 404);
      if (outcome === "live") return sendJson(res, { error: "conversation is still being recorded" }, 409);
      res.statusCode = 204;
      res.end();
    })
    .add("GET", "/api/keys",(_req, res) => sendJson(res, deps.keys?.list() ?? []))
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
    })
    .add("GET", "/api/devices", (req, res) =>
      deviceRoute(deps, req, res, false, (store) => {
        const { devices, pending } = store.list();
        sendJson(res, { devices: devices.map((d) => withConnected(deps, d)), pending });
      }),
    )
    .add("POST", "/api/devices/pending/:id/accept", (req, res, { id }) =>
      deviceRoute(deps, req, res, true, (store, body) => sendJson(res, withConnected(deps, store.accept(id, body)), 201)),
    )
    .add("DELETE", "/api/devices/pending/:id", (req, res, { id }) =>
      deviceRoute(deps, req, res, false, (store) => {
        store.ignore(id);
        res.statusCode = 204;
        res.end();
      }),
    )
    .add("PUT", "/api/devices/:id", (req, res, { id }) =>
      deviceRoute(deps, req, res, true, (store, body) => sendJson(res, withConnected(deps, store.update(id, body)))),
    )
    // Replacing, revoking and deleting end the device's open sessions; replacing so the old key stops at once.
    .add("POST", "/api/devices/:id/replace-key", (req, res, { id }) =>
      deviceRoute(deps, req, res, true, (store, body) => {
        const d = store.replaceKey(id, body);
        deps.deviceSessions?.disconnect(id);
        sendJson(res, withConnected(deps, d));
      }),
    )
    .add("POST", "/api/devices/:id/revoke", (req, res, { id }) =>
      deviceRoute(deps, req, res, false, (store) => {
        const d = store.revoke(id);
        deps.deviceSessions?.disconnect(id);
        sendJson(res, withConnected(deps, d));
      }),
    )
    .add("DELETE", "/api/devices/:id", (req, res, { id }) =>
      deviceRoute(deps, req, res, false, (store) => {
        store.remove(id);
        deps.deviceSessions?.disconnect(id);
        res.statusCode = 204;
        res.end();
      }),
    )
    .add("GET", "/api/jobs", (_req, res) => sendJson(res, deps.jobs?.list() ?? []))
    .add("GET", "/api/jobs/:owner/:name/runs", (_req, res, { owner, name }) => {
      const runs = deps.jobs?.runs(`${owner}/${name}`);
      if (!runs) return sendJson(res, { error: `unknown job "${owner}/${name}"` }, 404);
      sendJson(res, runs);
    })
    .add("POST", "/api/jobs/:owner/:name/run", (_req, res, { owner, name }) => {
      const r = deps.jobs?.runNow(`${owner}/${name}`, "manual") ?? { status: "unknown" as const };
      if (r.status === "unknown") return sendJson(res, { error: `unknown job "${owner}/${name}"` }, 404);
      if (r.status === "running") return sendJson(res, { error: "job is already running" }, 409);
      sendJson(res, { runId: r.runId }, 202);
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/") && !SAFE_METHODS.has(req.method ?? "GET") && isCrossOrigin(req)) {
      return sendJson(res, { error: "cross-origin requests may not change Friday" }, 403);
    }
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

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handle(req, res);
    } catch (e) {
      // A failing route answers 500 instead of becoming an unhandled rejection that ends the process.
      console.error(`${req.method} ${req.url} failed`, e);
      if (!res.headersSent) sendJson(res, { error: "internal error" }, 500);
      else res.end();
    }
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when a browser sent this request from another site. The portal has no login, so without this a
 * web page visited on the LAN could POST to the API (a CORS "simple request" needs no preflight) and,
 * for example, add an MCP server or overwrite configuration. Non-browser clients send neither header and pass.
 */
export function isCrossOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // "null" and other opaque origins
  }
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
