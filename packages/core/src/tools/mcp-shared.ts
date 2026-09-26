/** Helpers shared by the MCP config loader and the remote module host. */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "@friday/sdk";

/** Gemini function names: letters, digits, underscore, dot, colon, dash; must not start with a digit. */
export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.:-]/g, "_").replace(/^[^a-zA-Z_]/, "_");
}

/** `<prefix>__<tool>`, sanitized and kept within Gemini's name length limit. */
export function prefixedName(prefix: string, tool: string): string {
  return `${sanitize(prefix)}__${sanitize(tool)}`.slice(0, 128);
}

/** Flatten an MCP CallToolResult into something Gemini can read. */
export function toResult(r: Awaited<ReturnType<Client["callTool"]>>): ToolResult {
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
