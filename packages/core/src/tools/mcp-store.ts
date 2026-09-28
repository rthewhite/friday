/**
 * MCP server definitions in friday.db. Servers are reached over streamable HTTP only; Friday never
 * spawns processes for MCP. Headers are plain or secret; secret values are AES-256-GCM encrypted with
 * the master key (AAD `mcp:<server>` / `header:<name>`) and never leave the store except through
 * `resolve()`, which the MCP source uses to connect.
 */
import type { DatabaseSync } from "node:sqlite";
import { SCHEDULINGS, type Scheduling } from "@friday/sdk";
import { decrypt, encrypt } from "../secrets/crypto.js";

/** A header as written. A secret without `value` keeps the stored value. */
export interface HeaderInput {
  name: string;
  value?: string;
  secret: boolean;
}

export interface ServerInput {
  name: string;
  enabled: boolean;
  url: string;
  headers: HeaderInput[];
  include?: string[];
  exclude?: string[];
  scheduling?: Scheduling;
  prefix?: string;
}

/** A header as listed: plain headers carry their value, secret headers never do. */
export interface StoredHeader {
  name: string;
  secret: boolean;
  value?: string;
}

export interface StoredServer extends Omit<ServerInput, "headers"> {
  headers: StoredHeader[];
  createdAt: string;
  updatedAt: string;
}

/** What the MCP source connects with: every header value in plaintext. */
export interface ResolvedServer extends Omit<ServerInput, "headers"> {
  headers: Record<string, string>;
}

/** Invalid definition; maps to 400. */
export class McpInputError extends Error {}

/** A new secret value was supplied without a master key; maps to 503. */
export class McpStoreDisabled extends Error {
  constructor() {
    super("secret values need FRIDAY_MASTER_KEY (32 bytes, base64); plain values still work");
  }
}

/** Create with a name that is taken; maps to 409. */
export class McpServerExists extends Error {
  constructor(name: string) {
    super(`MCP server "${name}" already exists`);
  }
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Validate a create (`name` undefined: taken from the body) or an update of server `name` (the body
 * may repeat it but not change it). Empty lists and strings count as unset.
 */
export function parseServerInput(body: unknown, name?: string): ServerInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new McpInputError("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (name === undefined) {
    if (typeof b.name !== "string" || !NAME.test(b.name)) throw new McpInputError("name must start with a letter and contain only letters, digits, _ or - (max 32)");
    name = b.name;
  } else if (b.name !== undefined && b.name !== name) {
    throw new McpInputError("name cannot be changed; delete the server and create a new one");
  }
  if ((b.transport !== undefined && b.transport !== "http") || b.command !== undefined) {
    throw new McpInputError("only MCP servers reachable over HTTP are supported; Friday does not start MCP server processes");
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new McpInputError("enabled must be a boolean");
  if (typeof b.url !== "string" || !b.url.trim()) throw new McpInputError("a url is required");
  let url: URL;
  try {
    url = new URL(b.url.trim());
  } catch {
    throw new McpInputError("url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpInputError("url must be http or https");

  const out: ServerInput = { name, enabled: b.enabled !== false, url: b.url.trim(), headers: headers(b.headers) };
  const include = stringList(b.include, "include");
  const exclude = stringList(b.exclude, "exclude");
  if (include) out.include = include;
  if (exclude) out.exclude = exclude;
  if (b.scheduling !== undefined && b.scheduling !== null && b.scheduling !== "") {
    if (!SCHEDULINGS.includes(b.scheduling as Scheduling)) throw new McpInputError(`scheduling must be one of ${SCHEDULINGS.join(", ")}`);
    out.scheduling = b.scheduling as Scheduling;
  }
  if (b.prefix !== undefined && b.prefix !== null && b.prefix !== "") {
    if (typeof b.prefix !== "string") throw new McpInputError("prefix must be a string");
    out.prefix = b.prefix;
  }
  return out;
}

function stringList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new McpInputError(`${field} must be a list of strings`);
  return v.length ? (v as string[]) : undefined;
}

function headers(v: unknown): HeaderInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new McpInputError("headers must be a list of { name, value, secret }");
  const seen = new Set<string>();
  return v.map((e) => {
    if (!e || typeof e !== "object" || typeof e.name !== "string") throw new McpInputError("each header needs a name");
    if (!HEADER_NAME.test(e.name)) throw new McpInputError(`invalid header name "${e.name}"`);
    // Header names are case-insensitive on the wire.
    const id = e.name.toLowerCase();
    if (seen.has(id)) throw new McpInputError(`duplicate header "${e.name}"`);
    seen.add(id);
    if (e.secret !== undefined && typeof e.secret !== "boolean") throw new McpInputError(`secret of header "${e.name}" must be a boolean`);
    if (e.value !== undefined && typeof e.value !== "string") throw new McpInputError(`value of header "${e.name}" must be a string`);
    // Rejected here rather than at connect time, where the error could quote (part of) a secret.
    if (typeof e.value === "string" && /[\0-\x08\x0a-\x1f\x7f]/.test(e.value)) {
      throw new McpInputError(`value of header "${e.name}" contains a line break or control character`);
    }
    const secret = e.secret === true;
    // A blank secret means "keep what is stored".
    const value = secret && e.value === "" ? undefined : e.value;
    return value === undefined ? { name: e.name, secret } : { name: e.name, value, secret };
  });
}

interface ServerRow {
  name: string;
  enabled: number;
  url: string;
  include_json: string | null;
  exclude_json: string | null;
  scheduling: Scheduling | null;
  prefix: string | null;
  created_at: string;
  updated_at: string;
}

interface HeaderRow {
  server: string;
  name: string;
  position: number;
  secret: number;
  plaintext: string | null;
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  tag: Uint8Array | null;
}

type NewHeader = Omit<HeaderRow, "server" | "position">;

const aadScope = (server: string) => `mcp:${server}`;
const aadKey = (name: string) => `header:${name}`;

export class McpServerStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer | undefined,
  ) {}

  /** True when secret values can be written and read. */
  get secretsEnabled(): boolean {
    return this.masterKey !== undefined;
  }

  list(): StoredServer[] {
    const rows = this.db.prepare("SELECT * FROM mcp_servers ORDER BY name").all() as unknown as ServerRow[];
    return rows.map((r) => this.toStored(r));
  }

  get(name: string): StoredServer | undefined {
    const row = this.row(name);
    return row && this.toStored(row);
  }

  /** @throws McpServerExists, McpInputError, McpStoreDisabled */
  create(input: ServerInput): StoredServer {
    if (this.row(input.name)) throw new McpServerExists(input.name);
    const rows = this.headerRows(input, new Map());
    const now = new Date().toISOString();
    this.tx(() => {
      this.db
        .prepare("INSERT INTO mcp_servers (name, enabled, url, include_json, exclude_json, scheduling, prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.name, ...this.columns(input), now, now);
      this.insertHeaders(input.name, rows);
    });
    return this.get(input.name)!;
  }

  /**
   * Replace the definition of `input.name`. Headers are replaced as a set; a secret without a value
   * keeps the stored value for that header. Nothing is written when any header is rejected.
   * Returns undefined when the server does not exist.
   * @throws McpInputError, McpStoreDisabled
   */
  update(input: ServerInput): StoredServer | undefined {
    if (!this.row(input.name)) return undefined;
    const stored = new Map(this.headers(input.name).map((h) => [h.name, h]));
    const rows = this.headerRows(input, stored);
    this.tx(() => {
      this.db
        .prepare("UPDATE mcp_servers SET enabled = ?, url = ?, include_json = ?, exclude_json = ?, scheduling = ?, prefix = ?, updated_at = ? WHERE name = ?")
        .run(...this.columns(input), new Date().toISOString(), input.name);
      this.db.prepare("DELETE FROM mcp_server_headers WHERE server = ?").run(input.name);
      this.insertHeaders(input.name, rows);
    });
    return this.get(input.name);
  }

  /** Removes the server and, by cascade, its headers. */
  delete(name: string): boolean {
    return this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name).changes > 0;
  }

  /**
   * The definition with every header value in plaintext, or undefined when the server does not
   * exist. Throws an error naming the header (never its value) when a secret cannot be read.
   */
  resolve(name: string): ResolvedServer | undefined {
    const row = this.row(name);
    if (!row) return undefined;
    const { headers: _h, createdAt: _c, updatedAt: _u, ...def } = this.toStored(row);
    const out: ResolvedServer = { ...def, headers: {} };
    for (const h of this.headers(name)) out.headers[h.name] = this.plaintext(name, h);
    return out;
  }

  private plaintext(server: string, h: HeaderRow): string {
    if (h.secret !== 1) return h.plaintext ?? "";
    if (!this.masterKey) throw new Error(`secret header "${h.name}" requires FRIDAY_MASTER_KEY`);
    try {
      return decrypt(this.masterKey, aadScope(server), aadKey(h.name), { ciphertext: Buffer.from(h.ciphertext!), iv: Buffer.from(h.iv!), tag: Buffer.from(h.tag!) });
    } catch {
      throw new Error(`secret header "${h.name}" cannot be decrypted; wrong FRIDAY_MASTER_KEY?`);
    }
  }

  /** Build every header row up front so a rejected header leaves the stored definition untouched. */
  private headerRows(input: ServerInput, stored: Map<string, HeaderRow>): NewHeader[] {
    return input.headers.map((h) => {
      if (!h.secret) {
        if (h.value === undefined) throw new McpInputError(`plain header "${h.name}" needs a value`);
        return { name: h.name, secret: 0, plaintext: h.value, ciphertext: null, iv: null, tag: null };
      }
      if (h.value !== undefined) return this.sealed(input.name, h.name, h.value);
      const prev = stored.get(h.name);
      if (!prev) throw new McpInputError(`secret header "${h.name}" has no stored value; enter one`);
      if (prev.secret === 1) return { name: h.name, secret: 1, plaintext: null, ciphertext: prev.ciphertext, iv: prev.iv, tag: prev.tag };
      // Plain value turned secret without retyping it: encrypt what is stored.
      return this.sealed(input.name, h.name, prev.plaintext ?? "");
    });
  }

  private sealed(server: string, name: string, value: string): NewHeader {
    if (!this.masterKey) throw new McpStoreDisabled();
    const s = encrypt(this.masterKey, aadScope(server), aadKey(name), value);
    return { name, secret: 1, plaintext: null, ciphertext: s.ciphertext, iv: s.iv, tag: s.tag };
  }

  private insertHeaders(server: string, rows: NewHeader[]): void {
    const insert = this.db.prepare("INSERT INTO mcp_server_headers (server, name, position, secret, plaintext, ciphertext, iv, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    rows.forEach((r, i) => insert.run(server, r.name, i, r.secret, r.plaintext, r.ciphertext, r.iv, r.tag));
  }

  private columns(i: ServerInput) {
    const json = (v: string[] | undefined) => (v ? JSON.stringify(v) : null);
    return [i.enabled ? 1 : 0, i.url, json(i.include), json(i.exclude), i.scheduling ?? null, i.prefix ?? null] as const;
  }

  private row(name: string): ServerRow | undefined {
    return this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as unknown as ServerRow | undefined;
  }

  private headers(server: string): HeaderRow[] {
    return this.db.prepare("SELECT * FROM mcp_server_headers WHERE server = ? ORDER BY position").all(server) as unknown as HeaderRow[];
  }

  private toStored(r: ServerRow): StoredServer {
    const headers = this.headers(r.name).map((h): StoredHeader => (h.secret === 1 ? { name: h.name, secret: true } : { name: h.name, secret: false, value: h.plaintext ?? "" }));
    const s: StoredServer = { name: r.name, enabled: r.enabled === 1, url: r.url, headers, createdAt: r.created_at, updatedAt: r.updated_at };
    if (r.include_json !== null) s.include = JSON.parse(r.include_json);
    if (r.exclude_json !== null) s.exclude = JSON.parse(r.exclude_json);
    if (r.scheduling !== null) s.scheduling = r.scheduling;
    if (r.prefix !== null) s.prefix = r.prefix;
    return s;
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
