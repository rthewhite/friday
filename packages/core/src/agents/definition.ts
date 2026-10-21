/**
 * Agent definitions: the one validation every write and every run start goes through (`parseAgent`), and
 * the tools an agent gets from the registry (`resolveTools`). A future `create_agent` tool validates here too.
 */
import { DEFAULT_TIME_ZONE, nextCronRun, type ToolRegistry } from "@friday/sdk";

export type ToolMode = "auto" | "approve";

export interface ToolEntry {
  /** An exact tool name, or a pattern where `*` matches any run of characters. */
  pattern: string;
  mode: ToolMode;
}

export interface Budgets {
  maxToolCalls: number;
  /** Input and output tokens of all model calls of a run together. */
  maxTokens: number;
  maxMinutes: number;
}

export interface AgentDefinition {
  name: string;
  description: string;
  instructions: string;
  /** Five-field cron expression in the household zone. */
  schedule?: string;
  enabled: boolean;
  /** May be started by voice and chat (`run_agent`). */
  startable: boolean;
  tools: ToolEntry[];
  budgets: Budgets;
}

/** [min, max, default] per budget. */
export const BUDGETS: Record<keyof Budgets, readonly [number, number, number]> = {
  maxToolCalls: [1, 200, 30],
  maxTokens: [10_000, 2_000_000, 200_000],
  maxMinutes: [1, 60, 10],
};

export const MAX_NAME = 40;
export const MAX_DESCRIPTION = 200;
export const MAX_INSTRUCTIONS = 20_000;
export const MAX_TOOL_ENTRIES = 50;
const NAME = /^[a-z][a-z0-9-]*$/;
/** Tool-name characters (as sanitized for Gemini) plus `*`. */
const PATTERN = /^[A-Za-z0-9_.:*-]{1,128}$/;

/** An invalid definition; maps to 400. */
export class AgentInputError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate and normalise a definition. On create `name` is undefined and taken from the body; on update the
 * body may repeat the name but not change it. Throws AgentInputError naming the first problem.
 */
export function parseAgent(body: unknown, name?: string): AgentDefinition {
  if (!isObject(body)) throw new AgentInputError("body must be a JSON object");
  if (name === undefined) {
    if (typeof body.name !== "string" || !NAME.test(body.name) || body.name.length > MAX_NAME) {
      throw new AgentInputError(`name must be kebab-case (lowercase letters, digits and -, starting with a letter), at most ${MAX_NAME} characters`);
    }
    name = body.name;
  } else if (body.name !== undefined && body.name !== name) {
    throw new AgentInputError("name cannot be changed; create a new agent instead");
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION || /[\r\n]/.test(description)) {
    throw new AgentInputError(`description must be one line of 1 to ${MAX_DESCRIPTION} characters`);
  }
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  if (!instructions || instructions.length > MAX_INSTRUCTIONS) throw new AgentInputError(`instructions must be 1 to ${MAX_INSTRUCTIONS} characters`);

  const out: AgentDefinition = {
    name,
    description,
    instructions,
    enabled: flag(body.enabled, "enabled", true),
    startable: flag(body.startable, "startable", false),
    tools: tools(body.tools),
    budgets: budgets(body.budgets),
  };
  if (body.schedule !== undefined && body.schedule !== null && body.schedule !== "") {
    if (typeof body.schedule !== "string") throw new AgentInputError("schedule must be a cron expression");
    const schedule = body.schedule.trim().replace(/\s+/g, " ");
    try {
      nextCronRun(schedule, DEFAULT_TIME_ZONE, new Date());
    } catch (e) {
      throw new AgentInputError(`schedule "${schedule}" is not a five-field cron expression: ${e instanceof Error ? e.message : e}`);
    }
    if (schedule.split(" ").length !== 5) throw new AgentInputError(`schedule "${schedule}" is not a five-field cron expression`);
    out.schedule = schedule;
  }
  return out;
}

function flag(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new AgentInputError(`${field} must be true or false`);
  return v;
}

function tools(v: unknown): ToolEntry[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new AgentInputError("tools must be a list of { pattern, mode }");
  if (v.length > MAX_TOOL_ENTRIES) throw new AgentInputError(`at most ${MAX_TOOL_ENTRIES} tool entries`);
  return v.map((e, i) => {
    if (!isObject(e) || typeof e.pattern !== "string") throw new AgentInputError(`tool entry ${i + 1} needs a pattern`);
    const pattern = e.pattern.trim();
    if (!PATTERN.test(pattern)) throw new AgentInputError(`tool pattern "${pattern}" may only contain letters, digits, _ . : - and *`);
    if (e.mode !== "auto" && e.mode !== "approve") throw new AgentInputError(`mode of "${pattern}" must be auto or approve`);
    return { pattern, mode: e.mode };
  });
}

function budgets(v: unknown): Budgets {
  if (v !== undefined && v !== null && !isObject(v)) throw new AgentInputError("budgets must be an object");
  const b = (v ?? {}) as Record<string, unknown>;
  const out = {} as Budgets;
  for (const [key, [min, max, fallback]] of Object.entries(BUDGETS) as [keyof Budgets, readonly [number, number, number]][]) {
    const n = b[key];
    if (n === undefined || n === null) out[key] = fallback;
    else if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new AgentInputError(`${key} must be a whole number from ${min} to ${max}`);
    else out[key] = n;
  }
  return out;
}

/** Anchored regular expression for a pattern: `*` matches anything, every other character itself. */
export function patternRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

export interface ResolvedTools {
  /** Tool name -> mode, for the tools offered in the agent channel that an entry matches; `approve` wins. */
  tools: Map<string, ToolMode>;
  /** Patterns that matched no tool. */
  unmatched: string[];
}

export function resolveTools(def: Pick<AgentDefinition, "tools">, registry: Pick<ToolRegistry, "declarations">): ResolvedTools {
  const names = registry.declarations("agent").map((d) => d.name);
  const tools = new Map<string, ToolMode>();
  const unmatched: string[] = [];
  for (const entry of def.tools) {
    const re = patternRegExp(entry.pattern);
    const hits = names.filter((n) => re.test(n));
    if (!hits.length) unmatched.push(entry.pattern);
    for (const n of hits) if (tools.get(n) !== "approve") tools.set(n, entry.mode);
  }
  return { tools, unmatched };
}
