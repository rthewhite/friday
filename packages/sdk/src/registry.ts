import { SCHEDULINGS, type FunctionDeclaration, type Scheduling, type Tool, type ToolResult } from "./tool.js";

export interface CallResult {
  result: ToolResult;
  scheduling: Scheduling;
  /** Set when the handler asked to end the conversation (reserved `endConversation` key). */
  endConversation?: string;
}

export interface ToolEntry {
  name: string;
  owner: string;
  description: string;
}

/**
 * Owner-tagged tool registry. Core creates one instance; modules reach it through
 * `ctx.defineTool`, MCP servers register as `mcp:<server>`. Sessions snapshot
 * `declarations()` when they open.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, { tool: Tool; owner: string }>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly log: Pick<Console, "error"> = console) {}

  add<A>(owner: string, tool: Tool<A>): Tool<A> {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    this.tools.set(tool.name, { tool, owner });
    this.emit();
    return tool;
  }

  /** Unregister every tool with this owner; returns how many were removed. */
  removeOwner(owner: string): number {
    let n = 0;
    for (const [name, e] of this.tools) {
      if (e.owner === owner) {
        this.tools.delete(name);
        n++;
      }
    }
    if (n) this.emit();
    return n;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  /** Snapshot of what the model should see. */
  declarations(): FunctionDeclaration[] {
    return [...this.tools.values()].map(({ tool: { name, description, parameters, parametersJsonSchema } }) =>
      parametersJsonSchema ? { name, description, parametersJsonSchema } : { name, description, parameters },
    );
  }

  list(): ToolEntry[] {
    return [...this.tools.values()].map(({ tool, owner }) => ({ name: tool.name, owner, description: tool.description }));
  }

  names(owner?: string): string[] {
    return [...this.tools.values()].filter((e) => !owner || e.owner === owner).map((e) => e.tool.name);
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallResult> {
    const e = this.tools.get(name);
    if (!e) return { result: { error: `unknown tool ${name}` }, scheduling: "INTERRUPT" };
    try {
      const { scheduling, endConversation, ...result } = await e.tool.handler(args ?? {});
      const out: CallResult = { result, scheduling: pickScheduling(scheduling) ?? e.tool.scheduling ?? "INTERRUPT" };
      if (typeof endConversation === "string") out.endConversation = endConversation;
      return out;
    } catch (err) {
      this.log.error(`tool ${name} failed`, err);
      return { result: { error: String(err) }, scheduling: "INTERRUPT" };
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function pickScheduling(v: unknown): Scheduling | undefined {
  return SCHEDULINGS.includes(v as Scheduling) ? (v as Scheduling) : undefined;
}
