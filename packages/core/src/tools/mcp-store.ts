/**
 * MCP server definitions in friday.db. Env and header entries are plain or secret; secret values are
 * AES-256-GCM encrypted with the master key (AAD `mcp:<server>` / `<kind>:<name>`) and never leave the
 * store except through `resolve()`, which the MCP source uses to connect.
 */
import type { DatabaseSync } from "node:sqlite";
import { SCHEDULINGS, type Scheduling } from "@friday/sdk";
import { decrypt, encrypt } from "../secrets/crypto.js";

export type Transport = "stdio" | "http";
export type EntryKind = "env" | "header";

/** An env or header entry as written. A secret without `value` keeps the stored value. */
export interface EntryInput {
  name: string;
  value?: string;
  secret: boolean;
}

export interface ServerInput {
  name: string;
  enabled: boolean;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  env: EntryInput[];
  headers: EntryInput[];
  include?: string[];
  exclude?: string[];
  scheduling?: Scheduling;
  prefix?: string;
}

/** An entry as listed: plain entries carry their value, secret entries never do. */
export interface StoredEntry {
  name: string;
  secret: boolean;
  value?: string;
}

export interface StoredServer extends Omit<ServerInput, "env" | "headers"> {
  env: StoredEntry[];
  headers: StoredEntry[];
  createdAt: string;
  updatedAt: string;
}

/** What the MCP source connects with: every value in plaintext. */
export interface ResolvedServer extends Omit<ServerInput, "env" | "headers"> {
  env: Record<string, string>;
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
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const label = (kind: EntryKind) => (kind === "header" ? "header" : "env");

/**
 * Validate a create (`name` undefined: taken from the body) or an update of server `name` (the body
 * may repeat it but not change it). Fields of the other transport are dropped, empty lists and
 * strings count as unset.
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
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new McpInputError("enabled must be a boolean");
  if (b.transport !== "stdio" && b.transport !== "http") throw new McpInputError('transport must be "stdio" or "http"');

  const out: ServerInput = { name, enabled: b.enabled !== false, transport: b.transport, env: [], headers: [] };
  if (b.transport === "stdio") {
    if (typeof b.command !== "string" || !b.command.trim()) throw new McpInputError("a stdio server needs a command");
    out.command = b.command.trim();
    out.args = stringList(b.args, "args");
    out.env = entries(b.env, "env");
  } else {
    if (typeof b.url !== "string" || !b.url.trim()) throw new McpInputError("an http server needs a url");
    let url: URL;
    try {
      url = new URL(b.url.trim());
    } catch {
      throw new McpInputError("url is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpInputError("url must be http or https");
    out.url = b.url.trim();
    out.headers = entries(b.headers, "header");
  }
  out.include = stringList(b.include, "include");
  out.exclude = stringList(b.exclude, "exclude");
  if (b.scheduling !== undefined && b.scheduling !== null && b.scheduling !== "") {
    if (!SCHEDULINGS.includes(b.scheduling as Scheduling)) throw new McpInputError(`scheduling must be one of ${SCHEDULINGS.join(", ")}`);
    out.scheduling = b.scheduling as Scheduling;
  }
  if (b.prefix !== undefined && b.prefix !== null && b.prefix !== "") {
    if (typeof b.prefix !== "string") throw new McpInputError("prefix must be a string");
    out.prefix = b.prefix;
  }
  for (const k of ["args", "include", "exclude", "scheduling", "prefix"] as const) if (out[k] === undefined) delete out[k];
  return out;
}

function stringList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new McpInputError(`${field} must be a list of strings`);
  return v.length ? (v as string[]) : undefined;
}

function entries(v: unknown, kind: EntryKind): EntryInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new McpInputError(`${kind === "header" ? "headers" : "env"} must be a list of { name, value, secret }`);
  const seen = new Set<string>();
  return v.map((e) => {
    if (!e || typeof e !== "object" || typeof e.name !== "string") throw new McpInputError(`each ${label(kind)} entry needs a name`);
    const valid = kind === "header" ? HEADER_NAME : ENV_NAME;
    if (!valid.test(e.name)) throw new McpInputError(`invalid ${label(kind)} name "${e.name}"`);
    // Header names are case-insensitive on the wire.
    const id = kind === "header" ? e.name.toLowerCase() : e.name;
    if (seen.has(id)) throw new McpInputError(`duplicate ${label(kind)} "${e.name}"`);
    seen.add(id);
    if (e.secret !== undefined && typeof e.secret !== "boolean") throw new McpInputError(`secret of ${label(kind)} "${e.name}" must be a boolean`);
    if (e.value !== undefined && typeof e.value !== "string") throw new McpInputError(`value of ${label(kind)} "${e.name}" must be a string`);
    // Rejected here rather than at connect time, where the error could quote (part of) a secret.
    if (typeof e.value === "string" && (kind === "header" ? /[\0-\x08\x0a-\x1f\x7f]/ : /\0/).test(e.value)) {
      throw new McpInputError(`value of ${label(kind)} "${e.name}" contains a line break or control character`);
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
  transport: Transport;
  command: string | null;
  args_json: string | null;
  url: string | null;
  include_json: string | null;
  exclude_json: string | null;
  scheduling: Scheduling | null;
  prefix: string | null;
  created_at: string;
  updated_at: string;
}

interface EntryRow {
  server: string;
  kind: EntryKind;
  name: string;
  position: number;
  secret: number;
  plaintext: string | null;
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  tag: Uint8Array | null;
}

type NewEntry = Omit<EntryRow, "server" | "position">;

const aadScope = (server: string) => `mcp:${server}`;
const aadKey = (kind: EntryKind, name: string) => `${kind}:${name}`;

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
    const rows = this.entryRows(input, new Map());
    const now = new Date().toISOString();
    this.tx(() => {
      this.db
        .prepare("INSERT INTO mcp_servers (name, enabled, transport, command, args_json, url, include_json, exclude_json, scheduling, prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.name, ...this.columns(input), now, now);
      this.insertEntries(input.name, rows);
    });
    return this.get(input.name)!;
  }

  /**
   * Replace the definition of `input.name`. Entries are replaced as a set; a secret without a value
   * keeps the stored value for that entry. Nothing is written when any entry is rejected.
   * Returns undefined when the server does not exist.
   * @throws McpInputError, McpStoreDisabled
   */
  update(input: ServerInput): StoredServer | undefined {
    if (!this.row(input.name)) return undefined;
    const stored = new Map(this.entries(input.name).map((e) => [aadKey(e.kind, e.name), e]));
    const rows = this.entryRows(input, stored);
    this.tx(() => {
      this.db
        .prepare("UPDATE mcp_servers SET enabled = ?, transport = ?, command = ?, args_json = ?, url = ?, include_json = ?, exclude_json = ?, scheduling = ?, prefix = ?, updated_at = ? WHERE name = ?")
        .run(...this.columns(input), new Date().toISOString(), input.name);
      this.db.prepare("DELETE FROM mcp_server_entries WHERE server = ?").run(input.name);
      this.insertEntries(input.name, rows);
    });
    return this.get(input.name);
  }

  /** Removes the server and, by cascade, its entries. */
  delete(name: string): boolean {
    return this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name).changes > 0;
  }

  /**
   * The definition with every value in plaintext, or undefined when the server does not exist.
   * Throws an error naming the entry (never its value) when a secret cannot be read.
   */
  resolve(name: string): ResolvedServer | undefined {
    const row = this.row(name);
    if (!row) return undefined;
    const { env: _env, headers: _headers, createdAt: _c, updatedAt: _u, ...def } = this.toStored(row);
    const out: ResolvedServer = { ...def, env: {}, headers: {} };
    for (const e of this.entries(name)) {
      (e.kind === "header" ? out.headers : out.env)[e.name] = this.plaintext(name, e);
    }
    return out;
  }

  private plaintext(server: string, e: EntryRow): string {
    if (e.secret !== 1) return e.plaintext ?? "";
    if (!this.masterKey) throw new Error(`secret ${label(e.kind)} "${e.name}" requires FRIDAY_MASTER_KEY`);
    try {
      return decrypt(this.masterKey, aadScope(server), aadKey(e.kind, e.name), { ciphertext: Buffer.from(e.ciphertext!), iv: Buffer.from(e.iv!), tag: Buffer.from(e.tag!) });
    } catch {
      throw new Error(`secret ${label(e.kind)} "${e.name}" cannot be decrypted; wrong FRIDAY_MASTER_KEY?`);
    }
  }

  /** Build every entry row up front so a rejected entry leaves the stored definition untouched. */
  private entryRows(input: ServerInput, stored: Map<string, EntryRow>): NewEntry[] {
    const all = [...input.env.map((e) => ({ kind: "env" as const, e })), ...input.headers.map((e) => ({ kind: "header" as const, e }))];
    return all.map(({ kind, e }) => {
      if (!e.secret) {
        if (e.value === undefined) throw new McpInputError(`plain ${label(kind)} "${e.name}" needs a value`);
        return { kind, name: e.name, secret: 0, plaintext: e.value, ciphertext: null, iv: null, tag: null };
      }
      if (e.value !== undefined) return this.sealed(input.name, kind, e.name, e.value);
      const prev = stored.get(aadKey(kind, e.name));
      if (!prev) throw new McpInputError(`secret ${label(kind)} "${e.name}" has no stored value; enter one`);
      if (prev.secret === 1) return { kind, name: e.name, secret: 1, plaintext: null, ciphertext: prev.ciphertext, iv: prev.iv, tag: prev.tag };
      // Plain value turned secret without retyping it: encrypt what is stored.
      return this.sealed(input.name, kind, e.name, prev.plaintext ?? "");
    });
  }

  private sealed(server: string, kind: EntryKind, name: string, value: string): NewEntry {
    if (!this.masterKey) throw new McpStoreDisabled();
    const s = encrypt(this.masterKey, aadScope(server), aadKey(kind, name), value);
    return { kind, name, secret: 1, plaintext: null, ciphertext: s.ciphertext, iv: s.iv, tag: s.tag };
  }

  private insertEntries(server: string, rows: NewEntry[]): void {
    const insert = this.db.prepare("INSERT INTO mcp_server_entries (server, kind, name, position, secret, plaintext, ciphertext, iv, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    rows.forEach((r, i) => insert.run(server, r.kind, r.name, i, r.secret, r.plaintext, r.ciphertext, r.iv, r.tag));
  }

  private columns(i: ServerInput) {
    const json = (v: string[] | undefined) => (v ? JSON.stringify(v) : null);
    return [i.enabled ? 1 : 0, i.transport, i.command ?? null, json(i.args), i.url ?? null, json(i.include), json(i.exclude), i.scheduling ?? null, i.prefix ?? null] as const;
  }

  private row(name: string): ServerRow | undefined {
    return this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as unknown as ServerRow | undefined;
  }

  private entries(server: string): EntryRow[] {
    return this.db.prepare("SELECT * FROM mcp_server_entries WHERE server = ? ORDER BY position").all(server) as unknown as EntryRow[];
  }

  private toStored(r: ServerRow): StoredServer {
    const all = this.entries(r.name);
    const listed = (kind: EntryKind) =>
      all
        .filter((e) => e.kind === kind)
        .map((e): StoredEntry => (e.secret === 1 ? { name: e.name, secret: true } : { name: e.name, secret: false, value: e.plaintext ?? "" }));
    const s: StoredServer = { name: r.name, enabled: r.enabled === 1, transport: r.transport, env: listed("env"), headers: listed("header"), createdAt: r.created_at, updatedAt: r.updated_at };
    if (r.command !== null) s.command = r.command;
    if (r.args_json !== null) s.args = JSON.parse(r.args_json);
    if (r.url !== null) s.url = r.url;
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
