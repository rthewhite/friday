import type { Schema } from "../tool.js";

/** Convert a Gemini-style parameter schema to JSON Schema for MCP `inputSchema`. */
export function toJsonSchema(s: Schema | undefined): Record<string, unknown> {
  if (!s) return { type: "object", properties: {} };
  const out: Record<string, unknown> = {};
  if (s.type) out.type = s.type.toLowerCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.format) out.format = s.format;
  if (s.nullable) out.type = [out.type as string, "null"];
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.type === "OBJECT" && !s.properties) out.properties = {};
  return out;
}
