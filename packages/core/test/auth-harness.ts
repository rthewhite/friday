/**
 * Friday's app with OIDC login against the fake provider, on loopback, plus a tiny cookie-keeping browser. Shared by
 * the login, session and access tests.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ToolRegistry, type FridayModule } from "@friday/sdk";
import { createApp, type AppDeps } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { McpServerStore } from "../src/tools/mcp-store.js";
import { migrate, migrations } from "../src/storage/db.js";
import { Auth } from "../src/auth/auth.js";
import { UserStore } from "../src/auth/users.js";
import { SessionStore } from "../src/auth/sessions.js";
import { OidcClient } from "../src/auth/oidc.js";
import { loginRedirectUri, type OidcSettings } from "../src/auth/config.js";
import { startFakeProvider, type FakeProvider, type Person } from "./oidc-fixture.js";

export const quiet = { log() {}, warn() {}, error() {} };

export interface AuthApp {
  base: string;
  provider: FakeProvider;
  db: DatabaseSync;
  users: UserStore;
  sessions: SessionStore;
  auth: Auth;
  /** Move the clock the session store and the OIDC client see. */
  advance(ms: number): void;
  logs: string[];
  browser(): Browser;
  close(): Promise<void>;
}

export interface Browser {
  cookies: Map<string, string>;
  /** fetch with this browser's cookies and Origin; never follows redirects. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The whole login: /auth/login, the provider, /auth/callback. Resolves with the callback's response. */
  login(returnTo?: string, person?: Person): Promise<Response>;
}

export interface AuthAppOptions {
  person?: Person;
  /** Extra app dependencies (registry, host and mcp are provided). */
  deps?: (base: { registry: ToolRegistry; host: ModuleHost; db: DatabaseSync }) => Partial<AppDeps>;
  /** Public URL; defaults to the app's own http://127.0.0.1:<port>. */
  publicUrl?: string;
  settings?: Partial<OidcSettings>;
  /** In-process modules to load, for their routes and tools. */
  modules?: FridayModule[];
}

export async function startAuthApp(o: AuthAppOptions = {}): Promise<AuthApp> {
  const provider = await startFakeProvider(o.person);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const users = new UserStore(db, now);
  const sessions = new SessionStore(db, randomBytes(32), now);
  const settings: OidcSettings = { issuer: provider.issuer, clientId: provider.clientId, clientSecret: provider.clientSecret, userGroup: "friday-users", adminGroup: "friday-admins", ...o.settings };
  let base = "";
  const publicUrl = () => o.publicUrl ?? base;
  const logs: string[] = [];
  const log = { log: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push(a.join(" ")) };
  const oidc = new OidcClient(settings, () => loginRedirectUri(publicUrl()));
  const auth = new Auth({ mode: { kind: "oidc", oidc: settings }, users, sessions, oidc, publicUrl, log });
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  if (o.modules) await host.load(o.modules);
  const mcp = new McpSource(registry, new McpServerStore(db, undefined), { log: quiet });
  const server: Server = createServer(createApp({ registry, host, mcp, webDir: "/nonexistent", ...o.deps?.({ registry, host, db }), auth: { auth, users, sessions, oidc, publicUrl, log } }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const app: AuthApp = {
    base,
    provider,
    db,
    users,
    sessions,
    auth,
    logs,
    advance: (ms) => (offset += ms),
    browser() {
      const cookies = new Map<string, string>();
      const b: Browser = {
        cookies,
        async fetch(path, init = {}) {
          const headers = new Headers(init.headers);
          if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
          const res = await fetch(new URL(path, base), { ...init, headers, redirect: "manual" });
          for (const c of res.headers.getSetCookie()) {
            const [pair, ...attrs] = c.split(";");
            const eq = pair.indexOf("=");
            const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
            if (!value || attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) cookies.delete(name);
            else cookies.set(name, value);
          }
          return res;
        },
        async login(returnTo, person) {
          if (person) provider.person = person;
          const start = await b.fetch(`/auth/login${returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`}`);
          if (start.status !== 302) throw new Error(`login answered ${start.status}`);
          const { code, state } = provider.authorize(start.headers.get("location")!);
          return b.fetch(`/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
        },
      };
      return b;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await provider.close();
      db.close();
    },
  };
  return app;
}

export const member: Person = { sub: "sub-sanne", email: "sanne@example.org", name: "Sanne", groups: ["friday-users"] };
export const admin: Person = { sub: "sub-owner", email: "owner@example.org", name: "Owner", groups: ["friday-admins"] };
