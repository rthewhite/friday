/**
 * Tool registry. Register with defineTool(); declarations are sent to Gemini
 * on session start and calls are dispatched by name. Handlers may be async.
 */
import type { FunctionDeclaration, Schema } from "@google/genai";

export type Scheduling = "INTERRUPT" | "WHEN_IDLE" | "SILENT";
export type ToolResult = Record<string, unknown>;

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters?: Schema;
  /** Raw JSON Schema alternative to `parameters` (used for MCP tools). */
  parametersJsonSchema?: unknown;
  /** How Gemini surfaces the result once it arrives. */
  scheduling?: Scheduling;
  handler: (args: A) => ToolResult | Promise<ToolResult>;
}

const tools = new Map<string, Tool>();

export function defineTool<A>(t: Tool<A>): Tool<A> {
  if (tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
  tools.set(t.name, t);
  return t;
}

export function declarations(): FunctionDeclaration[] {
  return [...tools.values()].map(({ name, description, parameters, parametersJsonSchema }) =>
    parametersJsonSchema ? { name, description, parametersJsonSchema } : { name, description, parameters },
  );
}

export async function callTool(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<{ result: ToolResult; scheduling: Scheduling }> {
  const t = tools.get(name);
  if (!t) return { result: { error: `unknown tool ${name}` }, scheduling: "INTERRUPT" };
  try {
    const result = await t.handler(args ?? {});
    return { result, scheduling: t.scheduling ?? "INTERRUPT" };
  } catch (e) {
    console.error(`tool ${name} failed`, e);
    return { result: { error: String(e) }, scheduling: "INTERRUPT" };
  }
}

export function toolNames(): string[] {
  return [...tools.keys()];
}

/** Import every module that registers tools, then attach MCP servers. */
export async function loadTools(): Promise<void> {
  await import("./builtin.js");
  const { loadMcpTools } = await import("./mcp.js");
  await loadMcpTools();
}
