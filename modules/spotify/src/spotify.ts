/**
 * A small Spotify Web API client over an injectable fetch. The access token comes from the caller on every request
 * (ctx.oauth.token, which refreshes it) and never appears in an error message: errors name the status and Spotify's
 * own message only.
 */

export const SPOTIFY_API = "https://api.spotify.com/v1";
export const TIMEOUT_MS = 10_000;

const WHERE = "under Settings > Connections";

/** A failed Spotify request, with a message the user can act on. */
export class SpotifyError extends Error {
  override readonly name = "SpotifyError";
  constructor(readonly status: number | undefined, message: string) {
    super(message);
  }
}

export interface SpotifyClientOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type SpotifyGet = <T>(path: string, token: string) => Promise<T>;

/** Spotify's error body: `{ "error": { "status": 403, "message": "..." } }`. */
async function spotifyMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string; error_description?: unknown };
    if (typeof body.error === "object" && typeof body.error?.message === "string") return body.error.message;
    if (typeof body.error_description === "string") return body.error_description;
  } catch {
    // not JSON
  }
  return undefined;
}

export function errorFor(status: number, message: string | undefined, retryAfter: string | null): SpotifyError {
  if (status === 401) return new SpotifyError(status, `Spotify rejected the login. Reconnect Spotify ${WHERE}.`);
  if (status === 403) {
    return new SpotifyError(status,
      `Spotify refused the request${message ? ` (${message})` : ""}. Either the connection lacks a permission (reconnect Spotify ${WHERE}), ` +
      "or the Spotify app does not allow this account (in development mode, add the account under the app's Users and Access).");
  }
  if (status === 429) {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : undefined;
    return new SpotifyError(status, seconds !== undefined
      ? `Spotify is rate-limiting Friday and asked to wait ${seconds} seconds.`
      : "Spotify is rate-limiting Friday. Try again in a little while.");
  }
  return new SpotifyError(status, `Spotify is unavailable (HTTP ${status}). Try again later.`);
}

export function createSpotifyClient(opts: SpotifyClientOptions = {}): SpotifyGet {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return async <T>(path: string, token: string): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${SPOTIFY_API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new SpotifyError(undefined, timedOut
        ? `Spotify did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again later.`
        : "Spotify is unavailable (network error). Try again later.");
    }
    if (!res.ok) throw errorFor(res.status, await spotifyMessage(res), res.headers.get("retry-after"));
    return (await res.json()) as T;
  };
}
