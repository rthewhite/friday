/**
 * Agents in friday.db: definitions (`AgentStore`), and runs with the actions they parked for approval
 * (`AgentRunStore`). Stores keep rows only; running and approving are the runtime's business.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDefinition, Budgets, ToolEntry } from "./definition.js";

export interface StoredAgent extends AgentDefinition {
  createdAt: string;
  updatedAt: string;
}

/** Create with a name that is taken; maps to 409. */
export class AgentExists extends Error {
  constructor(name: string) {
    super(`agent "${name}" already exists`);
  }
}

interface AgentRow {
  name: string;
  description: string;
  instructions: string;
  schedule: string | null;
  enabled: number;
  startable: number;
  tools_json: string;
  budgets_json: string;
  created_at: string;
  updated_at: string;
}

type Now = () => Date;

export class AgentStore {
  private readonly listeners = new Set<(name: string) => void>();

  constructor(private readonly db: DatabaseSync, private readonly now: Now = () => new Date()) {}

  list(): StoredAgent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY name").all() as unknown as AgentRow[]).map(toAgent);
  }

  get(name: string): StoredAgent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
    return row && toAgent(row);
  }

  /** @throws AgentExists */
  create(def: AgentDefinition): StoredAgent {
    if (this.get(def.name)) throw new AgentExists(def.name);
    const now = this.now().toISOString();
    this.db
      .prepare("INSERT INTO agents (name, description, instructions, schedule, enabled, startable, tools_json, budgets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(def.name, ...columns(def), now, now);
    this.emit(def.name);
    return this.get(def.name)!;
  }

  /** Replace a definition; undefined when there is no agent of that name. */
  update(def: AgentDefinition): StoredAgent | undefined {
    const n = this.db
      .prepare("UPDATE agents SET description = ?, instructions = ?, schedule = ?, enabled = ?, startable = ?, tools_json = ?, budgets_json = ?, updated_at = ? WHERE name = ?")
      .run(...columns(def), this.now().toISOString(), def.name).changes;
    if (!n) return undefined;
    this.emit(def.name);
    return this.get(def.name);
  }

  /** Removes the agent and, by cascade, its runs and actions. */
  delete(name: string): boolean {
    const gone = this.db.prepare("DELETE FROM agents WHERE name = ?").run(name).changes > 0;
    if (gone) this.emit(name);
    return gone;
  }

  /** Called with the agent's name after every create, update and delete. */
  onChange(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(name: string): void {
    for (const l of this.listeners) l(name);
  }
}

const columns = (d: AgentDefinition) =>
  [d.description, d.instructions, d.schedule ?? null, d.enabled ? 1 : 0, d.startable ? 1 : 0, JSON.stringify(d.tools), JSON.stringify(d.budgets)] as const;

function toAgent(r: AgentRow): StoredAgent {
  const a: StoredAgent = {
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    enabled: r.enabled === 1,
    startable: r.startable === 1,
    tools: JSON.parse(r.tools_json) as ToolEntry[],
    budgets: JSON.parse(r.budgets_json) as Budgets,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.schedule !== null) a.schedule = r.schedule;
  return a;
}

// ---- runs and actions --------------------------------------------------------------------------------------

export type RunTrigger = "schedule" | "portal" | "voice" | "chat";
export type RunOutcome = "running" | "ok" | "failed" | "budget_exceeded" | "cancelled";
export type ActionState = "pending" | "approving" | "executed" | "failed" | "rejected" | "expired";

export interface AgentRun {
  id: string;
  agent: string;
  trigger: RunTrigger;
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
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  state: ActionState;
  createdAt: string;
  decidedAt: string | null;
  result: unknown;
  error: string | null;
}

/** Runs kept per agent; runs with a pending action are kept beyond it. */
export const KEEP_RUNS = 50;
/** Pending actions expire after this long. */
export const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface RunRow {
  id: string;
  agent: string;
  trigger: RunTrigger;
  request: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: RunOutcome;
  error: string | null;
  summary: string | null;
  tool_calls: number;
  tokens: number;
  conversation_id: string | null;
}

interface ActionRow {
  id: string;
  run_id: string;
  agent: string;
  tool: string;
  args_json: string;
  state: ActionState;
  created_at: string;
  decided_at: string | null;
  result_json: string | null;
  error: string | null;
}

/** What `claim` and `reject` found: done, unknown id, already decided, or too old. */
export type Decision = "ok" | "missing" | "conflict" | "expired";

export class AgentRunStore {
  constructor(private readonly db: DatabaseSync, private readonly now: Now = () => new Date()) {}

  start(r: { agent: string; trigger: RunTrigger; request?: string }): AgentRun {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO agent_runs (id, agent, trigger, request, started_at, outcome) VALUES (?, ?, ?, ?, ?, 'running')")
      .run(id, r.agent, r.trigger, r.request ?? null, this.iso());
    return this.get(id)!;
  }

  /** Progress of a running run: its conversation and what it used so far. */
  progress(id: string, p: { conversationId?: string; toolCalls: number; tokens: number }): void {
    this.db
      .prepare("UPDATE agent_runs SET conversation_id = COALESCE(?, conversation_id), tool_calls = ?, tokens = ? WHERE id = ?")
      .run(p.conversationId ?? null, p.toolCalls, p.tokens, id);
  }

  finish(id: string, f: { outcome: Exclude<RunOutcome, "running">; error?: string; summary?: string; toolCalls: number; tokens: number; conversationId?: string }): AgentRun | undefined {
    this.db
      .prepare("UPDATE agent_runs SET ended_at = ?, outcome = ?, error = ?, summary = ?, tool_calls = ?, tokens = ?, conversation_id = COALESCE(?, conversation_id) WHERE id = ?")
      .run(this.iso(), f.outcome, f.error ?? null, f.summary ?? null, f.toolCalls, f.tokens, f.conversationId ?? null, id);
    const run = this.get(id);
    if (run) this.prune(run.agent);
    return run;
  }

  get(id: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row && toRun(row);
  }

  /** An agent's runs, newest first. */
  list(agent: string, limit = KEEP_RUNS): AgentRun[] {
    return (this.db.prepare("SELECT * FROM agent_runs WHERE agent = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(agent, limit) as unknown as RunRow[]).map(toRun);
  }

  last(agent: string): AgentRun | undefined {
    return this.list(agent, 1)[0];
  }

  /**
   * At startup: runs left `running`, and approved actions left `approving` (their call was cut off, so it may or
   * may not have happened), become failed. Returns how many runs and actions.
   */
  failInterrupted(): number {
    const at = this.iso();
    const runs = this.db.prepare("UPDATE agent_runs SET outcome = 'failed', error = 'interrupted by a restart', ended_at = ? WHERE outcome = 'running'").run(at).changes;
    const actions = this.db
      .prepare("UPDATE agent_actions SET state = 'failed', error = 'interrupted by a restart; the call may or may not have happened', decided_at = ? WHERE state = 'approving'")
      .run(at).changes;
    return Number(runs) + Number(actions);
  }

  /** Delete an agent's finished runs beyond the newest KEEP_RUNS, except runs with a pending action. */
  prune(agent: string): void {
    this.db
      .prepare(
        `DELETE FROM agent_runs WHERE agent = ? AND outcome <> 'running'
           AND id NOT IN (SELECT id FROM agent_runs WHERE agent = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)
           AND id NOT IN (SELECT run_id FROM agent_actions WHERE state IN ('pending', 'approving'))`,
      )
      .run(agent, agent, KEEP_RUNS);
  }

  // ---- actions

  park(a: { runId: string; agent: string; tool: string; args: Record<string, unknown> }): AgentAction {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO agent_actions (id, run_id, agent, tool, args_json, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .run(id, a.runId, a.agent, a.tool, JSON.stringify(a.args), this.iso());
    return this.action(id)!;
  }

  action(id: string): AgentAction | undefined {
    this.expire();
    const row = this.db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(id) as ActionRow | undefined;
    return row && toAction(row);
  }

  actions(runId: string): AgentAction[] {
    this.expire();
    return (this.db.prepare("SELECT * FROM agent_actions WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as unknown as ActionRow[]).map(toAction);
  }

  pendingCount(agent: string): number {
    this.expire();
    return (this.db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE agent = ? AND state = 'pending'").get(agent) as { n: number }).n;
  }

  /** Move a pending action to `approving`, so only one approval can ever execute it. */
  claim(id: string): Decision {
    return this.decide(id, "approving");
  }

  reject(id: string): Decision {
    return this.decide(id, "rejected");
  }

  /** The outcome of an approved action. */
  settle(id: string, s: { state: "executed" | "failed"; result?: unknown; error?: string }): AgentAction | undefined {
    this.db
      .prepare("UPDATE agent_actions SET state = ?, result_json = ?, error = ?, decided_at = ? WHERE id = ? AND state = 'approving'")
      .run(s.state, s.result === undefined ? null : JSON.stringify(s.result), s.error ?? null, this.iso(), id);
    return this.action(id);
  }

  /** Pending actions older than ACTION_TTL_MS become `expired`. Called by every read, so no job is needed. */
  expire(): void {
    const before = new Date(this.now().getTime() - ACTION_TTL_MS).toISOString();
    this.db.prepare("UPDATE agent_actions SET state = 'expired', decided_at = ? WHERE state = 'pending' AND created_at <= ?").run(this.iso(), before);
  }

  private decide(id: string, state: "approving" | "rejected"): Decision {
    this.expire();
    const changed = this.db.prepare("UPDATE agent_actions SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(state, this.iso(), id).changes;
    if (changed) return "ok";
    const row = this.db.prepare("SELECT state FROM agent_actions WHERE id = ?").get(id) as { state: ActionState } | undefined;
    if (!row) return "missing";
    return row.state === "expired" ? "expired" : "conflict";
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

const toRun = (r: RunRow): AgentRun => ({
  id: r.id,
  agent: r.agent,
  trigger: r.trigger,
  request: r.request,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  outcome: r.outcome,
  error: r.error,
  summary: r.summary,
  toolCalls: r.tool_calls,
  tokens: r.tokens,
  conversationId: r.conversation_id,
});

const toAction = (r: ActionRow): AgentAction => ({
  id: r.id,
  runId: r.run_id,
  agent: r.agent,
  tool: r.tool,
  args: JSON.parse(r.args_json) as Record<string, unknown>,
  state: r.state,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  result: r.result_json === null ? null : JSON.parse(r.result_json),
  error: r.error,
});
