/**
 * MCP loader. Reads mcp.json and registers every tool of every server in the
 * shared registry as `<server>__<tool>`, so Gemini sees MCP tools and native
 * tools identically.
 *
 * mcp.json:
 * {
 *   "servers": {
 *     "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
 *     "home": { "url": "http://homeassistant.local:8123/mcp", "headers": { "Authorization": "Bearer ..." },
 *               "include": ["turn_on", "turn_off"], "scheduling": "SILENT" }
 *   }
 * }
 */
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type Scheduling, type ToolResult } from "./index.js";

interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Only register these tool names (default: all). */
  include?: string[];
  exclude?: string[];
  scheduling?: Scheduling;
  /** Prefix for Gemini tool names; defaults to the server key. */
  prefix?: string;
}

interface McpConfig {
  servers: Record<string, ServerConfig>;
}

const clients: Client[] = [];

export async function loadMcpTools(path = process.env.FRIDAY_MCP_CONFIG ?? "mcp.json"): Promise<void> {
  let cfg: McpConfig;
  try {
    cfg = JSON.parse(await readFile(path, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    throw new Error(`invalid ${path}: ${e}`);
  }

  await Promise.all(
    Object.entries(cfg.servers ?? {}).map(([name, sc]) =>
      connectServer(name, sc).catch((e) => console.error(`mcp: server "${name}" failed to load:`, e?.message ?? e)),
    ),
  );
}

async function connectServer(name: string, sc: ServerConfig): Promise<void> {
  const client = new Client({ name: "friday", version: "0.1.0" });
  if (sc.command) {
    await client.connect(
      new StdioClientTransport({ command: sc.command, args: sc.args ?? [], env: { ...process.env, ...sc.env } as Record<string, string>, stderr: "ignore" }),
    );
  } else if (sc.url) {
    await client.connect(new StreamableHTTPClientTransport(new URL(sc.url), { requestInit: { headers: sc.headers } }));
  } else {
    throw new Error("server needs either `command` or `url`");
  }
  clients.push(client);

  const prefix = sanitize(sc.prefix ?? name);
  const { tools } = await client.listTools();
  let count = 0;
  for (const t of tools) {
    if (sc.include && !sc.include.includes(t.name)) continue;
    if (sc.exclude?.includes(t.name)) continue;
    const geminiName = `${prefix}__${sanitize(t.name)}`.slice(0, 128);
    defineTool({
      name: geminiName,
      description: t.description ?? t.name,
      parametersJsonSchema: t.inputSchema,
      scheduling: sc.scheduling,
      handler: async (args: Record<string, unknown>) => toResult(await client.callTool({ name: t.name, arguments: args })),
    });
    count++;
  }
  console.log(`mcp: ${name} -> ${count} tools`);
}

/** Flatten an MCP CallToolResult into something Gemini can read. */
function toResult(r: Awaited<ReturnType<Client["callTool"]>>): ToolResult {
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as ToolResult;
  const content = (r.content ?? []) as Array<{ type: string; text?: string; mimeType?: string }>;
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const other = content.filter((c) => c.type !== "text").map((c) => `[${c.type} ${c.mimeType ?? ""}]`);
  const out: ToolResult = {};
  if (text) out.result = maybeJson(text);
  if (other.length) out.attachments = other;
  if (r.isError) out.error = text || "tool reported an error";
  return out;
}

function maybeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Gemini function names: letters, digits, underscore, dot, colon, dash. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.:-]/g, "_").replace(/^[^a-zA-Z_]/, "_");
}

export async function closeMcp(): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}
