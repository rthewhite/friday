/**
 * A fake OpenID Connect provider on loopback for the login tests: discovery, an authorize step the test drives
 * directly (`authorize(url)` returns a code as if the user logged in), a token endpoint for codes (checking PKCE and
 * the client) and refresh tokens, userinfo, and an advertised end-session endpoint. Who logs in, whether refreshes
 * are refused or the provider is down, and what the ID token says are all set by the test.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface Person {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: string[];
}

interface Grant {
  person: Person;
  challenge: string;
  nonce?: string;
  redirectUri: string;
}

export interface FakeProvider {
  /** The issuer Friday is configured with. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The person the next `authorize` logs in; change it to change the claims later refreshes return. */
  person: Person;
  /** Refresh tokens are refused (as after a revocation). */
  refuseRefresh: boolean;
  /** The token endpoint answers 503. */
  down: boolean;
  /** The token endpoint never answers. */
  hang: boolean;
  /** The userinfo endpoint answers 503. */
  userinfoDown: boolean;
  /** Leave groups out of the ID token, so they must come from userinfo. */
  groupsOnlyInUserinfo: boolean;
  /** Extra or overriding ID token claims for the next code exchange (iss, aud, exp, nonce...). */
  idTokenOverride?: Record<string, unknown>;
  /** Issue no refresh token. */
  noRefreshToken: boolean;
  /** Counts of token requests by grant type. */
  calls: { authorization_code: number; refresh_token: number };
  /** Act as the user logging in at `url` (Friday's redirect): returns the code for the callback, with the state. */
  authorize(url: string): { code: string; state: string; redirectUri: string };
  close(): Promise<void>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function startFakeProvider(person: Person = { sub: "sub-owner", email: "owner@example.org", name: "Owner", groups: ["friday-admins"] }): Promise<FakeProvider> {
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, true>();
  const accessTokens = new Map<string, true>();
  let server: Server;

  const p: FakeProvider = {
    issuer: "",
    clientId: "friday",
    clientSecret: "s3cret",
    person,
    refuseRefresh: false,
    down: false,
    hang: false,
    userinfoDown: false,
    groupsOnlyInUserinfo: false,
    noRefreshToken: false,
    calls: { authorization_code: 0, refresh_token: 0 },
    authorize(url) {
      const u = new URL(url);
      if (!u.href.startsWith(`${base}/authorize`)) throw new Error(`not this provider's authorize URL: ${url}`);
      const q = u.searchParams;
      if (q.get("client_id") !== p.clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") throw new Error(`bad authorize request: ${url}`);
      const code = randomBytes(8).toString("hex");
      codes.set(code, { person: { ...p.person }, challenge: q.get("code_challenge")!, nonce: q.get("nonce") ?? undefined, redirectUri: q.get("redirect_uri")! });
      return { code, state: q.get("state")!, redirectUri: q.get("redirect_uri")! };
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };

  const idToken = (who: Person, nonce?: string, override?: Record<string, unknown>) => {
    const { groups, ...rest } = who;
    const claims = {
      iss: p.issuer,
      aud: p.clientId,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...rest,
      ...(p.groupsOnlyInUserinfo ? {} : { groups: groups ?? [] }),
      ...(nonce ? { nonce } : {}),
      ...override,
    };
    return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2ln`;
  };

  const tokens = (who: Person, nonce?: string, override?: Record<string, unknown>) => {
    const access = randomBytes(8).toString("hex");
    accessTokens.set(access, true);
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken(who, nonce, override) };
    if (!p.noRefreshToken) {
      const refresh = randomBytes(8).toString("hex");
      refreshTokens.set(refresh, true);
      out.refresh_token = refresh;
    }
    return out;
  };

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, o: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/o/friday/.well-known/openid-configuration") {
      return json(200, {
        issuer: p.issuer,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        end_session_endpoint: `${base}/o/friday/end-session/`,
      });
    }
    if (url.pathname === "/userinfo") {
      if (p.userinfoDown) return json(503, { error: "temporarily_unavailable" });
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (!token || !accessTokens.has(token)) return json(401, { error: "invalid_token" });
      return json(200, { ...p.person, groups: p.person.groups ?? [] });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      if (p.down) return json(503, { error: "temporarily_unavailable" });
      if (p.hang) return; // never answers; the client's timeout has to give up
      const form = await body(req);
      const basic = Buffer.from(`${p.clientId}:${p.clientSecret}`).toString("base64");
      if (req.headers.authorization !== `Basic ${basic}`) return json(401, { error: "invalid_client" });
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        p.calls.authorization_code++;
        const g = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!g) return json(400, { error: "invalid_grant" });
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== g.challenge || form.get("redirect_uri") !== g.redirectUri) return json(400, { error: "invalid_grant" });
        const out = tokens(g.person, g.nonce, p.idTokenOverride);
        p.idTokenOverride = undefined;
        return json(200, out);
      }
      if (grant === "refresh_token") {
        p.calls.refresh_token++;
        const token = form.get("refresh_token") ?? "";
        if (p.refuseRefresh || !refreshTokens.has(token)) return json(400, { error: "invalid_grant", error_description: "Token is not valid" });
        refreshTokens.delete(token);
        return json(200, tokens(p.person));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  p.issuer = `${base}/o/friday/`;
  return p;
}
