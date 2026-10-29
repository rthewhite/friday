import type { ConversationChannel } from "./conversations.js";
import { CHANNELS, SCHEDULINGS, type FunctionDeclaration, type Scheduling, type Tool, type ToolCallContext, type ToolResult } from "./tool.js";
import type { CallUser } from "./user.js";

export interface CallResult {
  result: ToolResult;
  scheduling: Scheduling;
  /** Set when the handler asked to end the conversation (reserved `endConversation` key). */
  endConversation?: string;
}

export interface CallOptions {
  /** Treat tools not offered in this channel as unknown. */
  channel?: ConversationChannel;
  /** Handed to the handler with the channel, in its call context. */
  conversationId?: string;
  /** The voice device the call comes from, handed to the handler in its call context. */
  device?: string;
  /** The user the call is for, handed to the handler in its call context. */
  user?: CallUser;
}

export interface ToolEntry {
  name: string;
  owner: string;
  description: string;
}

/** Whether a call's or a prompt's user is the household owner; the registry's view of the owner for `ownerOnly` tools. */
export type OwnerCheck = (user: CallUser | undefined) => boolean;

/**
 * Owner-tagged tool registry. Core creates one instance; modules reach it through
 * `ctx.defineTool`, MCP servers register as `mcp:<server>`. Voice sessions snapshot
 * `declarations("voice", user)` when they open; chat turns read `declarations("chat", user)`.
 * Until `setOwnerCheck` is called nobody counts as the owner, so `ownerOnly` tools are never offered.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, { tool: Tool; owner: string }>();
  private readonly listeners = new Set<() => void>();
  private isOwner: OwnerCheck = () => false;

  constructor(private readonly log: Pick<Console, "error"> = console) {}

  /** How to tell the household owner, for `ownerOnly` tools. */
  setOwnerCheck(check: OwnerCheck): void {
    this.isOwner = check;
  }

  add<A>(owner: string, tool: Tool<A>): Tool<A> {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    const ch = tool.channels;
    if (ch !== undefined && (!Array.isArray(ch) || !ch.length || ch.some((c) => !CHANNELS.includes(c)))) {
      throw new Error(`invalid channels for ${tool.name}`);
    }
    if (tool.ownerOnly !== undefined && tool.ownerOnly !== true) throw new Error(`invalid ownerOnly for ${tool.name}`);
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

  /** Unregister one tool, whatever its owner; returns whether there was one. */
  remove(name: string): boolean {
    if (!this.tools.delete(name)) return false;
    this.emit();
    return true;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  /**
   * Snapshot of what the model should see, narrowed to the tools offered in `channel` when given. `ownerOnly` tools
   * are left out unless `user` is the household owner.
   */
  declarations(channel?: ConversationChannel, user?: CallUser): FunctionDeclaration[] {
    const owner = this.isOwner(user);
    return [...this.tools.values()].filter(({ tool }) => offeredIn(tool, channel) && (owner || !tool.ownerOnly)).map(({ tool: { name, description, parameters, parametersJsonSchema } }) =>
      parametersJsonSchema ? { name, description, parametersJsonSchema } : { name, description, parameters },
    );
  }

  list(): ToolEntry[] {
    return [...this.tools.values()].map(({ tool, owner }) => ({ name: tool.name, owner, description: tool.description }));
  }

  names(owner?: string): string[] {
    return [...this.tools.values()].filter((e) => !owner || e.owner === owner).map((e) => e.tool.name);
  }

  async callTool(name: string, args: Record<string, unknown> | undefined, opts: CallOptions = {}): Promise<CallResult> {
    const e = this.tools.get(name);
    if (!e || !offeredIn(e.tool, opts.channel)) return { result: { error: `unknown tool ${name}` }, scheduling: "INTERRUPT" };
    if (e.tool.ownerOnly && !this.isOwner(opts.user)) return { result: { error: `${name} is only available to the household owner` }, scheduling: "INTERRUPT" };
    try {
      const { scheduling, endConversation, ...result } = await e.tool.handler(args ?? {}, context(opts));
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

function context({ channel, conversationId, device, user }: CallOptions): ToolCallContext {
  const call: ToolCallContext = {};
  if (channel) call.channel = channel;
  if (conversationId) call.conversationId = conversationId;
  if (device) call.device = device;
  if (user) call.user = { id: user.id, name: user.name };
  return call;
}

function offeredIn(tool: Tool, channel?: ConversationChannel): boolean {
  return !channel || !tool.channels || tool.channels.includes(channel);
}

function pickScheduling(v: unknown): Scheduling | undefined {
  return SCHEDULINGS.includes(v as Scheduling) ? (v as Scheduling) : undefined;
}
