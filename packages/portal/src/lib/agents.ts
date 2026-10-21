/** Shapes of `/api/agents` and how the Agents page shows them. */
export type ToolMode = "auto" | "approve";
export type RunOutcome = "running" | "ok" | "failed" | "budget_exceeded" | "cancelled";
export type ActionState = "pending" | "approving" | "executed" | "failed" | "rejected" | "expired";
export type Tone = "neutral" | "success" | "warning" | "error" | "accent";

export interface ToolEntry {
  pattern: string;
  mode: ToolMode;
}

export interface Budgets {
  maxToolCalls: number;
  maxTokens: number;
  maxMinutes: number;
}

export interface AgentRun extends Record<string, unknown> {
  id: string;
  agent: string;
  trigger: "schedule" | "portal" | "voice" | "chat";
  request: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: RunOutcome;
  error: string | null;
  summary: string | null;
  toolCalls: number;
  tokens: number;
  conversationId: string | null;
}

export interface AgentAction {
  id: string;
  runId: string;
  tool: string;
  args: Record<string, unknown>;
  state: ActionState;
  createdAt: string;
  decidedAt: string | null;
  result: unknown;
  error: string | null;
}

export interface Agent extends Record<string, unknown> {
  name: string;
  description: string;
  instructions: string;
  schedule?: string;
  enabled: boolean;
  startable: boolean;
  tools: ToolEntry[];
  budgets: Budgets;
  unmatched: string[];
  running: AgentRun | null;
  nextRunAt: string | null;
  lastRun: AgentRun | null;
  pendingActions: number;
}

export interface AgentTool {
  name: string;
  owner: string;
  description: string;
}

/** Budget ranges and defaults, as core checks them. */
export const BUDGETS: Record<keyof Budgets, { min: number; max: number; default: number; label: string }> = {
  maxToolCalls: { min: 1, max: 200, default: 30, label: "Tool calls" },
  maxTokens: { min: 10_000, max: 2_000_000, default: 200_000, label: "Tokens" },
  maxMinutes: { min: 1, max: 60, default: 10, label: "Minutes" },
};

/** Core's pattern rule: `*` matches any run of characters, every other character only itself. */
export function patternRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** The tools a pattern selects, in the order given. */
export function matching(pattern: string, tools: string[]): string[] {
  if (!pattern.trim()) return [];
  const re = patternRegExp(pattern.trim());
  return tools.filter((t) => re.test(t));
}

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** A cron expression in words when it is a common shape (`daily at 07:00`, `Sundays at 18:00`), else as written. */
export function describeSchedule(cron: string | undefined): string {
  if (!cron) return "on demand";
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || month !== "*") return cron;
  const at = `at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "*") return `daily ${at}`;
  if (dow === "1-5") return `weekdays ${at}`;
  if (dow === "0,6" || dow === "6,0") return `weekends ${at}`;
  if (/^[0-7]$/.test(dow)) return `${WEEKDAYS[Number(dow) % 7]} ${at}`;
  return cron;
}

export const outcomeTone: Record<RunOutcome, Tone> = { running: "accent", ok: "success", failed: "error", budget_exceeded: "warning", cancelled: "neutral" };
export const actionTone: Record<ActionState, Tone> = { pending: "accent", approving: "accent", executed: "success", failed: "error", rejected: "neutral", expired: "neutral" };

/** `1.2 s`, `3 min 4 s`; empty while running. */
export function runDuration(r: Pick<AgentRun, "startedAt" | "endedAt">): string {
  if (!r.endedAt) return "";
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The status shown for an agent: running, its last outcome, or never run. */
export function agentStatus(a: Pick<Agent, "running" | "lastRun">): { label: string; tone: Tone } {
  if (a.running) return { label: "running", tone: "accent" };
  if (!a.lastRun) return { label: "never run", tone: "neutral" };
  return { label: a.lastRun.outcome.replace("_", " "), tone: outcomeTone[a.lastRun.outcome] };
}
