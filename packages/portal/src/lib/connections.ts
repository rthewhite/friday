/** Shapes of `/api/oauth` and what Settings > Connections derives from them (see the oauth-connections spec). */
export type ConnectionState = "connected" | "disconnected" | "error";
export type Tone = "neutral" | "success" | "warning" | "error";

export interface Requester {
  module: string;
  scopes: string[];
  description?: string;
  granted: boolean;
}

export interface Connection extends Record<string, unknown> {
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
  missingScopes: { scope: string; modules: string[] }[];
  requesters: Requester[];
  state?: ConnectionState;
  error?: string;
  expiresAt?: string;
  redirectUri: string;
  updatedAt?: string;
}

export interface Provider {
  id: string;
  name: string;
  pkce: boolean;
  refresh: boolean;
}

/** The drawer's form. `provider` is a catalogue id or `generic`; a generic one's id is typed in `genericId`. */
export interface ConnectionDraft {
  provider: string;
  genericId: string;
  clientId: string;
  /** Empty means unchanged: a stored secret is never sent back to the browser. */
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  extraScopes: string;
}

export const blankDraft = (): ConnectionDraft => ({ provider: "", genericId: "", clientId: "", clientSecret: "", authUrl: "", tokenUrl: "", extraScopes: "" });

/** The form for an entry, or a blank one for a new connection. The client secret always starts empty. */
export function draftOf(c: Connection | null): ConnectionDraft {
  if (!c) return blankDraft();
  return {
    provider: c.generic ? "generic" : c.provider,
    genericId: c.generic ? c.provider : "",
    clientId: c.clientId ?? "",
    clientSecret: "",
    authUrl: c.authUrl ?? "",
    tokenUrl: c.tokenUrl ?? "",
    extraScopes: c.extraScopes.join(" "),
  };
}

export const isGeneric = (selected: Connection | null, d: ConnectionDraft) => (selected ? selected.generic : d.provider === "generic");

/** The connection's provider id: the entry's, the chosen catalogue provider, or the id typed for a generic one. */
export const providerIdOf = (selected: Connection | null, d: ConnectionDraft) =>
  selected?.provider ?? (d.provider === "generic" ? d.genericId.trim() : d.provider);

/** The callback URL to register at the provider; empty until there is a provider id. */
export const redirectUriOf = (base: string, providerId: string) => (providerId ? `${base}/api/oauth/${encodeURIComponent(providerId)}/callback` : "");

/** Scopes typed with spaces, commas or newlines between them. */
export const scopesOf = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Whether the form differs from what is stored. A connection that isn't set up yet always needs saving. */
export function isDirty(selected: Connection | null, d: ConnectionDraft): boolean {
  if (!selected?.configured) return true;
  return d.clientId.trim() !== (selected.clientId ?? "") || d.clientSecret !== "" || scopesOf(d.extraScopes).join(" ") !== selected.extraScopes.join(" ")
    || (selected.generic && (d.authUrl.trim() !== (selected.authUrl ?? "") || d.tokenUrl.trim() !== (selected.tokenUrl ?? "")));
}

/** Saving needs secrets enabled, a provider id, a client id, and for a generic provider both endpoints. */
export const canSave = (secretsEnabled: boolean, providerId: string, d: ConnectionDraft, generic: boolean) =>
  secretsEnabled && providerId !== "" && d.clientId.trim() !== "" && (!generic || (d.authUrl.trim() !== "" && d.tokenUrl.trim() !== ""));

/** The PUT body. The client secret is sent only when typed, the endpoints only for a generic provider. */
export function saveBody(d: ConnectionDraft, generic: boolean) {
  return {
    clientId: d.clientId.trim(),
    ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
    extraScopes: scopesOf(d.extraScopes),
    ...(generic ? { authUrl: d.authUrl.trim(), tokenUrl: d.tokenUrl.trim() } : {}),
  };
}

export const statusOf = (c: Connection) => (!c.configured ? "not set up" : c.state === "connected" && c.missingScopes.length ? "needs reconnect" : c.state!);

export function toneOf(c: Connection): Tone {
  if (!c.configured) return "neutral";
  if (c.state === "error") return "error";
  if (c.state === "connected") return c.missingScopes.length ? "warning" : "success";
  return "warning";
}

export function scopesSummary(c: Connection): string {
  if (c.missingScopes.length) return `${c.missingScopes.length} missing, reconnect`;
  if (c.grantedScopes) return `${c.grantedScopes.length} granted`;
  return c.requestedScopes.length ? `${c.requestedScopes.length} requested` : "none";
}
