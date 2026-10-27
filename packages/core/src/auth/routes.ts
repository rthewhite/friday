/**
 * The login: `/auth/login` sends the browser to the provider, `/auth/callback` checks what comes back, provisions the
 * user and starts a session, and `POST /auth/logout` ends it. The routes exist only with OIDC configured; without
 * it `/auth/*` answers 404 like any unknown path.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "../router.js";
import { sendJson } from "../router.js";
import { roleFromGroups, type Auth } from "./auth.js";
import { clearCookie, LOGIN_COOKIE_MAX_AGE_S, loginCookieName, readCookie, serializeCookie } from "./cookies.js";
import { LoginError, type OidcClient } from "./oidc.js";
import { SESSION_IDLE_MS, type SessionStore } from "./sessions.js";
import type { UserStore } from "./users.js";

export interface AuthRouteDeps {
  auth: Auth;
  oidc: OidcClient;
  users: UserStore;
  sessions: SessionStore;
  publicUrl: () => string | undefined;
  log?: Pick<Console, "log" | "warn">;
}

interface LoginState {
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

/**
 * `value` when it is a path on Friday itself, else `/`. Rejects `//host`, `/\host`, and whitespace or control
 * characters, which browsers strip from a Location header (so `/\t/evil` would become `//evil`).
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !/^\/(?![/\\])[^\x00-\x20\x7f\\]*$/.test(value)) return "/";
  return value;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A minimal page for login errors and refusals, outside the portal (which needs a session). */
function page(res: ServerResponse, status: number, title: string, message: string, links: { href: string; label: string }[]): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const a = links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join(" &middot; ");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} - Friday</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem}p{color:#a9aec0;line-height:1.5}a{color:#8ab4ff}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>${a}</p></main></body></html>`);
}

export function addAuthRoutes(router: Router, deps: AuthRouteDeps): void {
  const { auth, oidc, users, sessions, publicUrl } = deps;
  const log = deps.log ?? console;
  const cookieName = () => loginCookieName(publicUrl());

  const noAccess = async (res: ServerResponse, reason: string) => {
    const end = await oidc.endSessionUrl();
    page(res, 403, "No access to Friday", reason, [
      ...(end ? [{ href: end, label: "Log out of Authentik to use another account" }] : []),
      { href: "/auth/login", label: "Try again" },
    ]);
  };

  const failed = (res: ServerResponse, message: string, status = 400) =>
    page(res, status, "Login failed", message, [{ href: "/auth/login", label: "Try again" }]);

  router.add("GET", "/auth/login", async (_req, res, _params, url) => {
    let start;
    try {
      start = await oidc.start();
    } catch (e) {
      log.warn(`auth: login could not start: ${e instanceof Error ? e.message : e}`);
      return failed(res, "The login provider can't be reached. Try again in a moment.", 502);
    }
    const login: LoginState = { state: start.state, codeVerifier: start.codeVerifier, nonce: start.nonce, returnTo: safeReturnTo(url.searchParams.get("return_to")) };
    res.setHeader("set-cookie", serializeCookie(cookieName(), Buffer.from(JSON.stringify(login)).toString("base64url"), { maxAge: LOGIN_COOKIE_MAX_AGE_S, publicUrl: publicUrl() }));
    res.setHeader("cache-control", "no-store");
    res.statusCode = 302;
    res.setHeader("location", start.url.toString());
    res.end();
  });

  router.add("GET", "/auth/callback", async (req, res, _params, url) => {
    const login = readLogin(req, cookieName());
    // The login cookie is single use, whatever happens next.
    res.setHeader("set-cookie", clearCookie(cookieName(), publicUrl()));
    const q = url.searchParams;
    const providerError = q.get("error");
    if (providerError) {
      const description = q.get("error_description");
      return failed(res, `The login provider said: ${providerError}${description ? ` (${description})` : ""}.`);
    }
    const code = q.get("code");
    if (!login || !code || q.get("state") !== login.state) return failed(res, "This login link is not valid anymore. Start the login again.");

    let result;
    try {
      result = await oidc.finish(code, login.codeVerifier, login.nonce);
    } catch (e) {
      log.warn(`auth: login failed: ${e instanceof Error ? e.message : e}`);
      // Only a LoginError's message is meant for the page; anything else is described generically.
      return failed(res, e instanceof LoginError ? `The login could not be completed: ${e.message}.` : "The login could not be completed. Try again in a moment.", e instanceof LoginError ? 400 : 502);
    }
    const { claims, refreshToken } = result;
    const role = roleFromGroups(claims.groups, auth.settings!);
    if (!role) {
      log.log(`auth: refused ${claims.subject}: not in a Friday group (groups: ${JSON.stringify(claims.groups)})`);
      return noAccess(res, "Your account is not in a Friday group. Ask an admin to add you in Authentik.");
    }
    const provisioned = users.provision({ ...claims, role });
    if (!provisioned.ok) {
      const other = users.identity(provisioned.conflictingUserId);
      log.warn(`auth: refused ${claims.subject}: its email belongs to user ${provisioned.conflictingUserId} (subject ${other?.subject}); has the provider's subject mode changed?`);
      return noAccess(res, "Your email address belongs to another Friday account. An admin has to resolve this.");
    }
    const { user, created } = provisioned;
    if (user.disabled) {
      log.log(`auth: refused ${user.id}: disabled`);
      return noAccess(res, "Your Friday account is disabled. Ask an admin to enable it.");
    }
    const token = sessions.create(user.id, refreshToken);
    log.log(`auth: ${user.name} (${user.id}, ${user.role}) logged in${created ? " for the first time" : ""}`);
    res.setHeader("set-cookie", [
      clearCookie(cookieName(), publicUrl()),
      serializeCookie(auth.cookieName(), token, { maxAge: SESSION_IDLE_MS / 1000, publicUrl: publicUrl() }),
    ]);
    res.setHeader("cache-control", "no-store");
    res.statusCode = 302;
    res.setHeader("location", login.returnTo);
    res.end();
  });

  router.add("POST", "/auth/logout", async (req, res) => {
    sessions.endToken(readCookie(req.headers.cookie, auth.cookieName()));
    res.setHeader("set-cookie", clearCookie(auth.cookieName(), publicUrl()));
    sendJson(res, { endSessionUrl: (await oidc.endSessionUrl()) ?? null });
  });
}

function readLogin(req: IncomingMessage, name: string): LoginState | undefined {
  const raw = readCookie(req.headers.cookie, name);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<LoginState>;
    if (typeof v.state !== "string" || typeof v.codeVerifier !== "string" || typeof v.nonce !== "string") return undefined;
    return { state: v.state, codeVerifier: v.codeVerifier, nonce: v.nonce, returnTo: safeReturnTo(v.returnTo) };
  } catch {
    return undefined;
  }
}
