/**
 * /api/oauth: the provider catalogue, the connections listing (connections joined with the modules' requests and the
 * grants, never a secret or a token), connection and grant writes, and the authorize/callback pair of the login.
 * authorize and callback are GET, so the CSRF guard leaves them alone; the callback is a cross-site navigation from the
 * provider, which is why the state cookie is SameSite=Lax and the state/cookie pair is what refuses forged callbacks.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, type Router } from "../router.js";
import { catalogueEntry, providerListing, providerName } from "./catalogue.js";
import { OAuthFlowError, STATE_TTL_MS, type OAuthFlow } from "./flow.js";
import { requestBase, redirectUri } from "./redirect.js";
import type { MissingScope, OAuthRequests } from "./requests.js";
import { OAuthInputError, OAuthStoreDisabled, parseConnectionInput, type ConnectionState, type OAuthStore } from "./store.js";

export interface OAuthDeps {
  store: OAuthStore;
  requests: OAuthRequests;
  flow: OAuthFlow;
  /** Core's FRIDAY_PUBLIC_URL, read per request. */
  publicUrl: () => string | undefined;
}

export const STATE_COOKIE = "friday_oauth_state";
const PORTAL_PAGE = "/settings/connections";

export interface ConnectionEntry {
  provider: string;
  name: string;
  configured: boolean;
  generic: boolean;
  clientId?: string;
  hasClientSecret: boolean;
  authUrl?: string;
  tokenUrl?: string;
  extraScopes: string[];
  requestedScopes: string[];
  grantedScopes?: string[];
  missingScopes: MissingScope[];
  requesters: { module: string; scopes: string[]; description?: string; granted: boolean }[];
  state?: ConnectionState;
  error?: string;
  expiresAt?: string;
  redirectUri: string;
  updatedAt?: string;
}

/** One entry per provider that has a connection or a request, by provider name. */
export function connectionListing({ store, requests }: Pick<OAuthDeps, "store" | "requests">, base: string): ConnectionEntry[] {
  const byProvider = requests.byProvider();
  const stored = new Map(store.list().map((c) => [c.provider, c]));
  const providers = [...new Set([...stored.keys(), ...byProvider.keys()])];
  return providers
    .map((provider): ConnectionEntry => {
      const conn = stored.get(provider);
      const grants = conn ? store.grants(provider) : [];
      const extras = conn?.extraScopes ?? [];
      const generic = !catalogueEntry(provider);
      const defaults = generic ? requests.genericDefaults(provider) : undefined;
      const e: ConnectionEntry = {
        provider,
        name: providerName(provider),
        configured: conn !== undefined,
        generic,
        hasClientSecret: conn?.hasClientSecret ?? false,
        extraScopes: extras,
        requestedScopes: requests.requestedScopes(provider, grants, extras),
        missingScopes: conn?.hasTokens ? requests.missingScopes(provider, grants, extras, conn.grantedScopes) : [],
        requesters: (byProvider.get(provider) ?? []).map((r) => ({
          module: r.module,
          scopes: r.scopes,
          ...(r.description !== undefined && { description: r.description }),
          granted: grants.includes(r.module),
        })),
        redirectUri: redirectUri(base, provider),
      };
      if (conn) {
        e.clientId = conn.clientId;
        e.state = conn.state;
        if (conn.grantedScopes) e.grantedScopes = conn.grantedScopes;
        if (conn.error) e.error = conn.error;
        if (conn.expiresAt) e.expiresAt = conn.expiresAt;
        e.updatedAt = conn.updatedAt;
      }
      const authUrl = conn?.authUrl ?? defaults?.authUrl;
      const tokenUrl = conn?.tokenUrl ?? defaults?.tokenUrl;
      if (generic && authUrl) e.authUrl = authUrl;
      if (generic && tokenUrl) e.tokenUrl = tokenUrl;
      return e;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const baseOf = (deps: OAuthDeps, req: IncomingMessage) =>
  requestBase(deps.publicUrl(), req.headers, (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true);

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const stateCookie = (value: string, maxAge: number, secure: boolean) =>
  `${STATE_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/oauth; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end();
}

const noContent = (res: ServerResponse) => {
  res.statusCode = 204;
  res.end();
};

export function addOAuthRoutes(router: Router, deps: OAuthDeps | undefined): void {
  const need = (res: ServerResponse): OAuthDeps | undefined => {
    if (!deps) sendJson(res, { error: "OAuth connections are not available" }, 503);
    return deps;
  };
  router
    .add("GET", "/api/oauth/providers", (_req, res) => sendJson(res, providerListing()))
    .add("GET", "/api/oauth/connections", (req, res) => {
      const d = need(res);
      if (!d) return;
      sendJson(res, { secretsEnabled: d.store.secretsEnabled, connections: connectionListing(d, baseOf(d, req)) });
    })
    .add("PUT", "/api/oauth/connections/:provider", async (req, res, { provider }) => {
      const d = need(res);
      if (!d) return;
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, { error: "invalid JSON" }, 400);
      }
      try {
        d.store.upsert(parseConnectionInput(provider, body));
      } catch (e) {
        if (e instanceof OAuthInputError) return sendJson(res, { error: e.message }, 400);
        if (e instanceof OAuthStoreDisabled) return sendJson(res, { error: e.message }, 503);
        throw e;
      }
      sendJson(res, connectionListing(d, baseOf(d, req)).find((c) => c.provider === provider));
    })
    .add("DELETE", "/api/oauth/connections/:provider", (_req, res, { provider }) => {
      const d = need(res);
      if (!d) return;
      if (!d.store.delete(provider)) return sendJson(res, { error: `no connection for ${provider}` }, 404);
      noContent(res);
    })
    .add("PUT", "/api/oauth/connections/:provider/grants/:module", (_req, res, { provider, module }) => {
      const d = need(res);
      if (!d) return;
      if (!d.store.get(provider)) return sendJson(res, { error: `no connection for ${provider}` }, 404);
      if (!d.requests.forModule(provider, module)) return sendJson(res, { error: `module ${module} does not request ${provider}` }, 404);
      d.store.grant(provider, module);
      noContent(res);
    })
    .add("DELETE", "/api/oauth/connections/:provider/grants/:module", (_req, res, { provider, module }) => {
      const d = need(res);
      if (!d) return;
      if (!d.store.get(provider)) return sendJson(res, { error: `no connection for ${provider}` }, 404);
      d.store.revoke(provider, module);
      noContent(res);
    })
    .add("GET", "/api/oauth/:provider/authorize", (req, res, { provider }) => {
      const d = need(res);
      if (!d) return;
      const base = baseOf(d, req);
      let started: { url: URL; state: string };
      try {
        started = d.flow.start(provider, base);
      } catch (e) {
        if (e instanceof OAuthFlowError) return sendJson(res, { error: e.message }, e.status);
        throw e;
      }
      res.setHeader("set-cookie", stateCookie(started.state, STATE_TTL_MS / 1000, base.startsWith("https:")));
      redirect(res, started.url.toString());
    })
    .add("GET", "/api/oauth/:provider/callback", async (req, res, { provider }, url) => {
      const d = need(res);
      if (!d) return;
      const result = await d.flow.finish(provider, url.searchParams, cookie(req, STATE_COOKIE));
      res.setHeader("set-cookie", stateCookie("", 0, baseOf(d, req).startsWith("https:")));
      const q = new URLSearchParams({ provider, ...(result.ok ? { connected: "1" } : { error: result.error }) });
      redirect(res, `${PORTAL_PAGE}?${q}`);
    });
}
