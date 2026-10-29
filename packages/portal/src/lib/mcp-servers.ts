/** Shapes of `/api/mcp/servers` and the edit drawer's form in Settings > Configuration > MCP servers (see the secret-management spec). */
export type Channel = "voice" | "chat" | "agent";
export const CHANNELS: Channel[] = ["voice", "chat", "agent"];
export type Scheduling = "INTERRUPT" | "WHEN_IDLE" | "SILENT";

export interface ApiHeader {
  name: string;
  secret: boolean;
  value?: string;
}

export interface Server extends Record<string, unknown> {
  name: string;
  enabled: boolean;
  url: string;
  headers: ApiHeader[];
  include?: string[];
  exclude?: string[];
  scheduling?: Scheduling;
  prefix?: string;
  /** Unset: every channel. */
  channels?: Channel[];
  status: "loaded" | "failed" | "disabled";
  error?: string;
  tools: string[];
  updatedAt: string;
}

/** A header row in the form. `stored` marks a secret whose value the server keeps. */
export interface HeaderRow {
  name: string;
  value: string;
  secret: boolean;
  stored: boolean;
}

export interface ServerDraft {
  name: string;
  enabled: boolean;
  url: string;
  headers: HeaderRow[];
  /** One tool name per line. */
  include: string;
  exclude: string;
  scheduling: "" | Scheduling;
  prefix: string;
  channels: Channel[];
}

export const channelsOf = (s: Server): Channel[] => s.channels ?? CHANNELS;

export const blankDraft = (): ServerDraft => ({
  name: "",
  enabled: true,
  url: "",
  headers: [],
  include: "",
  exclude: "",
  scheduling: "",
  prefix: "",
  channels: [...CHANNELS],
});

/** Header rows for a stored server: secret values never reach the browser, so their rows start empty and `stored`. */
export const rowsOf = (list: ApiHeader[]): HeaderRow[] => list.map((h) => ({ name: h.name, value: h.secret ? "" : (h.value ?? ""), secret: h.secret, stored: h.secret }));

export function draftOf(s: Server): ServerDraft {
  return {
    name: s.name,
    enabled: s.enabled,
    url: s.url,
    headers: rowsOf(s.headers),
    include: (s.include ?? []).join("\n"),
    exclude: (s.exclude ?? []).join("\n"),
    scheduling: s.scheduling ?? "",
    prefix: s.prefix ?? "",
    channels: [...channelsOf(s)],
  };
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/** A stored secret switched to plain has no value to fall back on, so it must be typed in. */
export const needsValue = (r: HeaderRow) => r.stored && !r.secret && !r.value;

/**
 * The POST (adding) or PUT body. Rows without a name are dropped; a stored secret left empty is sent without a value,
 * which keeps it. All three channels are stored as unset (every channel) by the server.
 */
export function saveBody(d: ServerDraft, adding: boolean) {
  return {
    ...(adding ? { name: d.name.trim() } : {}),
    enabled: d.enabled,
    url: d.url,
    headers: d.headers
      .filter((r) => r.name.trim())
      .map((r) => (r.secret && r.stored && !r.value ? { name: r.name.trim(), secret: true } : { name: r.name.trim(), value: r.value, secret: r.secret })),
    include: lines(d.include),
    exclude: lines(d.exclude),
    scheduling: d.scheduling || undefined,
    prefix: d.prefix.trim() || undefined,
    channels: CHANNELS.filter((c) => d.channels.includes(c)),
  };
}

/** Saving needs a name when adding, a URL, a value for every secret switched to plain, and at least one channel. */
export const canSave = (d: ServerDraft, adding: boolean) =>
  (adding ? d.name.trim() !== "" : true) && d.url.trim() !== "" && !d.headers.some(needsValue) && d.channels.length > 0;

/** The server `?server=` names, but only on the MCP tab. */
export function serverFromQuery(query: Record<string, unknown>, servers: Server[]): Server | undefined {
  if (query.tab !== "mcp") return undefined;
  return servers.find((x) => x.name === query.server);
}
