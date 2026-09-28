/**
 * MCP tool source. Connects the MCP servers stored in friday.db (see mcp-store.ts) and registers
 * every tool of every server in core's registry as `<prefix>__<tool>` with owner `mcp:<server>`,
 * so Gemini sees MCP tools and native tools identically.
 *
 * Each server has its own state (`loaded`, `failed` with an error, or `disabled`). `apply(name)`
 * reconnects one server after its definition changed; calls for the same server run one after the
 * other, different servers in parallel. Open sessions keep the declarations they snapshotted.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolRegistry } from "@friday/sdk";
import { prefixedName, toResult } from "./mcp-shared.js";
import type { McpServerStore, ResolvedServer } from "./mcp-store.js";

export { sanitize, toResult } from "./mcp-shared.js";

export const mcpOwner = (server: string) => `mcp:${server}`;

export type McpStatus = "loaded" | "failed" | "disabled";

export interface McpServerState {
  name: string;
  status: McpStatus;
  error?: string;
  /** Registered tool names; empty unless loaded. */
  tools: string[];
}

export interface McpSourceOptions {
  /** Deadline for connecting and listing tools. */
  timeoutMs?: number;
  log?: Pick<Console, "log" | "error">;
}

interface State {
  status: McpStatus;
  error?: string;
  client?: Client;
}

export class McpSource {
  private readonly state = new Map<string, State>();
  /** Tail of each server's apply chain. */
  private readonly queue = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;
  private readonly log: Pick<Console, "log" | "error">;

  /** Without a store (minimal test apps) there are no servers. */
  constructor(
    private readonly registry: ToolRegistry,
    private readonly store?: McpServerStore,
    opts: McpSourceOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.log = opts.log ?? console;
  }

  /** Connect every stored server in parallel. Failures are recorded per server, never thrown. */
  async load(): Promise<void> {
    await Promise.all((this.store?.list() ?? []).map((s) => this.apply(s.name)));
  }

  /**
   * Bring server `name` in line with its stored definition: drop its tools and client, then connect
   * again if it still exists and is enabled. Resolves with its new state (undefined once deleted).
   */
  apply(name: string): Promise<McpServerState | undefined> {
    const run = (this.queue.get(name) ?? Promise.resolve()).then(() => this.reconnect(name));
    const tail = run.catch(() => {});
    this.queue.set(name, tail);
    void tail.then(() => {
      if (this.queue.get(name) === tail) this.queue.delete(name);
    });
    return run.then(() => this.stateOf(name));
  }

  stateOf(name: string): McpServerState | undefined {
    const s = this.state.get(name);
    if (!s) return undefined;
    const out: McpServerState = { name, status: s.status, tools: s.status === "loaded" ? this.registry.names(mcpOwner(name)) : [] };
    if (s.error) out.error = s.error;
    return out;
  }

  /** Every known server with its state, by name; for /api/modules and /api/mcp/servers. */
  servers(): McpServerState[] {
    return [...this.state.keys()].sort().map((n) => this.stateOf(n)!);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.state.keys()].map((n) => this.disconnect(n)));
    this.state.clear();
  }

  private async reconnect(name: string): Promise<void> {
    await this.disconnect(name);
    const def = this.store?.get(name);
    if (!def) {
      this.state.delete(name);
      return;
    }
    if (!def.enabled) {
      this.state.set(name, { status: "disabled" });
      return;
    }
    // Secret values, so they can be scrubbed from any error text.
    const secrets: string[] = [];
    try {
      const sc = this.store!.resolve(name)!;
      for (const e of def.env) if (e.secret && sc.env[e.name]) secrets.push(...secretParts(sc.env[e.name]));
      for (const e of def.headers) if (e.secret && sc.headers[e.name]) secrets.push(...secretParts(sc.headers[e.name]));
      const client = await this.connect(name, sc);
      this.state.set(name, { status: "loaded", client });
      this.log.log(`mcp: ${name} -> ${this.registry.names(mcpOwner(name)).length} tools`);
    } catch (e) {
      const error = scrub(e instanceof Error ? e.message : String(e), secrets);
      this.state.set(name, { status: "failed", error });
      this.log.error(`mcp: server "${name}" failed to load: ${error}`);
    }
  }

  private async disconnect(name: string): Promise<void> {
    this.registry.removeOwner(mcpOwner(name));
    const client = this.state.get(name)?.client;
    if (client) await client.close().catch(() => {});
  }

  /** Connect, list and register; on any failure nothing stays registered and the client is closed. */
  private async connect(name: string, sc: ResolvedServer): Promise<Client> {
    const client = new Client({ name: "friday", version: "0.1.0" });
    const transport =
      sc.transport === "stdio"
        ? new StdioClientTransport({ command: sc.command!, args: sc.args ?? [], env: { ...process.env, ...sc.env } as Record<string, string>, stderr: "ignore" })
        : new StreamableHTTPClientTransport(new URL(sc.url!), { requestInit: { headers: sc.headers } });
    const owner = mcpOwner(name);
    try {
      const tools = await withTimeout(
        client.connect(transport).then(() => client.listTools()).then((r) => r.tools),
        this.timeoutMs,
      );
      const prefix = sc.prefix ?? name;
      for (const t of tools) {
        if (sc.include && !sc.include.includes(t.name)) continue;
        if (sc.exclude?.includes(t.name)) continue;
        this.registry.add(owner, {
          name: prefixedName(prefix, t.name),
          description: t.description ?? t.name,
          parametersJsonSchema: t.inputSchema,
          scheduling: sc.scheduling,
          handler: async (args: Record<string, unknown>) => toResult(await client.callTool({ name: t.name, arguments: args })),
        });
      }
      return client;
    } catch (e) {
      this.registry.removeOwner(owner);
      await client.close().catch(() => {});
      throw e;
    }
  }
}

/** Reject with `timed out after <n>` when `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {}); // the loser of the race must not surface as an unhandled rejection
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** The whole value plus its long words, so `Bearer <token>` is also caught when only the token is echoed. */
function secretParts(value: string): string[] {
  return [value, ...value.split(/\s+/).filter((p) => p.length >= 8 && p !== value)];
}

function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}
