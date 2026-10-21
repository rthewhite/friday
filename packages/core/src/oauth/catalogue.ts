/**
 * OAuth providers: every Arctic provider with a standard constructor (client id, optional secret, redirect URI),
 * reached by class name, plus generic OAuth2 on Arctic's OAuth2Client. Arctic's classes carry the providers'
 * quirks (Basic auth, TikTok's client_key, Withings' wrapped response); the table only records how each class is
 * called. oauth-catalogue.test.ts checks every entry against the installed Arctic, so an upgrade that renames a
 * class or changes a signature fails CI instead of the first Connect.
 * Providers whose constructor needs a domain, tenant or key (Auth0, GitLab, Okta, Apple, ...) are not in the
 * catalogue; they connect as generic providers with their own URLs.
 */
import * as arctic from "arctic";

/** Which `createAuthorizationURL` signature the class has. */
export type AuthPattern =
  | "state-verifier-scopes" // (state, codeVerifier, scopes)
  | "state-scopes" //          (state, scopes)
  | "state-verifier" //        (state, codeVerifier)
  | "state-only" //            (state)
  | "scopes-only" //           (scopes); Friday adds state itself
  | "none"; //                 (); Friday adds state itself

export interface CatalogueEntry {
  id: string;
  /** Arctic class name. */
  className: string;
  name: string;
  auth: AuthPattern;
  /** The class has `refreshAccessToken`. */
  refresh: boolean;
  /** Constructor without a client secret: (clientId, redirectURI). */
  publicClient?: boolean;
  /** `refreshAccessToken(refreshToken, scopes)`. */
  refreshWithScopes?: boolean;
  /** `validateAuthorizationCode(code, scopes)`. */
  validateWithScopes?: boolean;
  /** Extra authorization parameters the provider needs (Google only returns a refresh token offline, with consent). */
  authParams?: Record<string, string>;
}

const e = (id: string, className: string, name: string, auth: AuthPattern, refresh: boolean, extra: Partial<CatalogueEntry> = {}): CatalogueEntry =>
  ({ id, className, name, auth, refresh, ...extra });

export const CATALOGUE: CatalogueEntry[] = [
  e("anilist", "AniList", "AniList", "state-only", false),
  e("atlassian", "Atlassian", "Atlassian", "state-scopes", true),
  e("autodesk", "Autodesk", "Autodesk", "state-verifier-scopes", true),
  e("battlenet", "BattleNet", "Battle.net", "state-scopes", false),
  e("bitbucket", "Bitbucket", "Bitbucket", "state-only", true),
  e("box", "Box", "Box", "state-scopes", true),
  e("bungie", "Bungie", "Bungie", "state-scopes", true),
  e("coinbase", "Coinbase", "Coinbase", "state-scopes", true),
  e("discord", "Discord", "Discord", "state-verifier-scopes", true),
  e("donation-alerts", "DonationAlerts", "DonationAlerts", "scopes-only", true, { refreshWithScopes: true }),
  e("dribbble", "Dribbble", "Dribbble", "state-scopes", false),
  e("dropbox", "Dropbox", "Dropbox", "state-scopes", true),
  e("epicgames", "EpicGames", "Epic Games", "state-scopes", true),
  e("etsy", "Etsy", "Etsy", "state-verifier-scopes", true, { publicClient: true }),
  e("facebook", "Facebook", "Facebook", "state-scopes", false),
  e("figma", "Figma", "Figma", "state-scopes", true),
  e("fortytwo", "FortyTwo", "42", "state-scopes", false),
  e("github", "GitHub", "GitHub", "state-scopes", true),
  e("google", "Google", "Google", "state-verifier-scopes", true, { authParams: { access_type: "offline", prompt: "consent" } }),
  e("intuit", "Intuit", "Intuit", "state-scopes", true),
  e("kakao", "Kakao", "Kakao", "state-scopes", true),
  e("kick", "Kick", "Kick", "state-verifier-scopes", true),
  e("lichess", "Lichess", "Lichess", "state-verifier-scopes", false, { publicClient: true }),
  e("line", "Line", "LINE", "state-verifier-scopes", true),
  e("linear", "Linear", "Linear", "state-scopes", false),
  e("linkedin", "LinkedIn", "LinkedIn", "state-scopes", true),
  e("mercadolibre", "MercadoLibre", "Mercado Libre", "state-verifier", true),
  e("mercadopago", "MercadoPago", "Mercado Pago", "state-verifier", true),
  e("myanimelist", "MyAnimeList", "MyAnimeList", "state-verifier", true),
  e("naver", "Naver", "Naver", "none", true),
  e("notion", "Notion", "Notion", "state-only", false),
  e("osu", "Osu", "osu!", "state-scopes", true),
  e("patreon", "Patreon", "Patreon", "state-scopes", true),
  e("polar", "Polar", "Polar", "state-verifier-scopes", true),
  e("reddit", "Reddit", "Reddit", "state-scopes", true),
  e("roblox", "Roblox", "Roblox", "state-verifier-scopes", true),
  e("shikimori", "Shikimori", "Shikimori", "state-only", true),
  e("slack", "Slack", "Slack", "state-scopes", false),
  e("spotify", "Spotify", "Spotify", "state-verifier-scopes", true),
  e("startgg", "StartGG", "start.gg", "state-scopes", true, { refreshWithScopes: true, validateWithScopes: true }),
  e("strava", "Strava", "Strava", "state-scopes", true),
  e("tiktok", "TikTok", "TikTok", "state-verifier-scopes", true),
  e("tiltify", "Tiltify", "Tiltify", "state-scopes", true),
  e("tumblr", "Tumblr", "Tumblr", "state-scopes", true),
  e("twitch", "Twitch", "Twitch", "state-scopes", true),
  e("twitter", "Twitter", "Twitter / X", "state-verifier-scopes", true),
  e("vk", "VK", "VK", "state-scopes", false),
  e("withings", "Withings", "Withings", "state-scopes", false),
  e("workos", "WorkOS", "WorkOS", "state-verifier", false),
  e("yahoo", "Yahoo", "Yahoo", "state-scopes", true),
  e("yandex", "Yandex", "Yandex", "state-scopes", true),
  e("zoom", "Zoom", "Zoom", "state-verifier-scopes", true),
];

export const GENERIC = "generic";

const byId = new Map(CATALOGUE.map((c) => [c.id, c]));

export const catalogueEntry = (provider: string): CatalogueEntry | undefined => byId.get(provider);

export const usesPkce = (auth: AuthPattern): boolean => auth === "state-verifier-scopes" || auth === "state-verifier";

export interface ProviderListing {
  id: string;
  name: string;
  pkce: boolean;
  refresh: boolean;
}

/** The catalogue sorted by name, then `generic`. */
export function providerListing(): ProviderListing[] {
  const list = CATALOGUE.map((c) => ({ id: c.id, name: c.name, pkce: usesPkce(c.auth), refresh: c.refresh }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...list, { id: GENERIC, name: "Generic OAuth2", pkce: true, refresh: true }];
}

/** Display name of a provider id: the catalogue's, else the id itself (generic connections). */
export const providerName = (provider: string): string => byId.get(provider)?.name ?? provider;

/** What a connection needs to build a client. */
export interface ClientConfig {
  provider: string;
  clientId: string;
  clientSecret?: string;
  /** Generic connections only. */
  authUrl?: string;
  tokenUrl?: string;
}

/** One provider, uniformly: Arctic's per-class signatures behind one shape. */
export interface OAuthClient {
  pkce: boolean;
  refresh: boolean;
  authorizationUrl(state: string, codeVerifier: string | undefined, scopes: string[]): URL;
  exchange(code: string, codeVerifier: string | undefined, scopes: string[]): Promise<arctic.OAuth2Tokens>;
  refreshToken(refreshToken: string, scopes: string[]): Promise<arctic.OAuth2Tokens>;
}

export type BuildClient = (config: ClientConfig, redirectUri: string) => OAuthClient;

/** The client config of a stored connection, with its decrypted client secret. */
export function clientConfig(conn: { provider: string; clientId: string; authUrl?: string; tokenUrl?: string }, clientSecret: string | undefined): ClientConfig {
  return {
    provider: conn.provider,
    clientId: conn.clientId,
    ...(clientSecret !== undefined && { clientSecret }),
    ...(conn.authUrl !== undefined && { authUrl: conn.authUrl }),
    ...(conn.tokenUrl !== undefined && { tokenUrl: conn.tokenUrl }),
  };
}

/** Arctic classes are only known by name at runtime; this is the shape the table describes. */
interface ArcticProvider {
  createAuthorizationURL(...args: unknown[]): URL;
  validateAuthorizationCode(...args: unknown[]): Promise<arctic.OAuth2Tokens>;
  refreshAccessToken?(...args: unknown[]): Promise<arctic.OAuth2Tokens>;
}
type ArcticClass = new (...args: (string | null)[]) => ArcticProvider;

export function arcticClass(className: string): ArcticClass | undefined {
  const c = (arctic as unknown as Record<string, unknown>)[className];
  return typeof c === "function" ? (c as ArcticClass) : undefined;
}

function catalogueClient(entry: CatalogueEntry, config: ClientConfig, redirectUri: string): OAuthClient {
  const Class = arcticClass(entry.className);
  if (!Class) throw new Error(`OAuth provider ${entry.id}: Arctic has no class ${entry.className}`);
  // null, not "": Arctic treats only null as a public client (client_id in the body, no Basic auth).
  const instance = entry.publicClient
    ? new Class(config.clientId, redirectUri)
    : new Class(config.clientId, config.clientSecret ?? null, redirectUri);
  const pkce = usesPkce(entry.auth);
  return {
    pkce,
    refresh: entry.refresh,
    authorizationUrl(state, verifier, scopes) {
      let url: URL;
      switch (entry.auth) {
        case "state-verifier-scopes": url = instance.createAuthorizationURL(state, verifier, scopes); break;
        case "state-scopes": url = instance.createAuthorizationURL(state, scopes); break;
        case "state-verifier": url = instance.createAuthorizationURL(state, verifier); break;
        case "state-only": url = instance.createAuthorizationURL(state); break;
        case "scopes-only": url = instance.createAuthorizationURL(scopes); break;
        case "none": url = instance.createAuthorizationURL(); break;
      }
      // Every login carries a state Friday checks on the way back, also for classes that don't set one.
      if (!url.searchParams.has("state")) url.searchParams.set("state", state);
      for (const [k, v] of Object.entries(entry.authParams ?? {})) url.searchParams.set(k, v);
      return url;
    },
    exchange(code, verifier, scopes) {
      if (pkce) return instance.validateAuthorizationCode(code, verifier);
      if (entry.validateWithScopes) return instance.validateAuthorizationCode(code, scopes);
      return instance.validateAuthorizationCode(code);
    },
    async refreshToken(refreshToken, scopes) {
      if (!entry.refresh || !instance.refreshAccessToken) throw new Error(`${entry.name} does not support token refresh`);
      return entry.refreshWithScopes ? instance.refreshAccessToken(refreshToken, scopes) : instance.refreshAccessToken(refreshToken);
    },
  };
}

function genericClient(config: ClientConfig, redirectUri: string): OAuthClient {
  const { authUrl, tokenUrl } = config;
  if (!authUrl || !tokenUrl) throw new Error(`OAuth provider ${config.provider}: a generic provider needs an authorization URL and a token URL`);
  const client = new arctic.OAuth2Client(config.clientId, config.clientSecret ?? null, redirectUri);
  return {
    pkce: true,
    refresh: true,
    authorizationUrl: (state, verifier, scopes) =>
      client.createAuthorizationURLWithPKCE(authUrl, state, arctic.CodeChallengeMethod.S256, verifier ?? "", scopes),
    exchange: (code, verifier) => client.validateAuthorizationCode(tokenUrl, code, verifier ?? null),
    refreshToken: (refreshToken) => client.refreshAccessToken(tokenUrl, refreshToken, []),
  };
}

/** The client for a connection: its catalogue class, or generic OAuth2 with the connection's URLs. */
export const buildClient: BuildClient = (config, redirectUri) => {
  const entry = byId.get(config.provider);
  return entry ? catalogueClient(entry, config, redirectUri) : genericClient(config, redirectUri);
};

export const generateState = arctic.generateState;
export const generateCodeVerifier = arctic.generateCodeVerifier;
