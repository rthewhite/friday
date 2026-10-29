/**
 * Agent runs: the shared model loop over an agent's own tools, with budgets, a conversation on the `agent`
 * channel, and `approve` tools parked as exact calls the user approves or rejects later. One run per agent at
 * a time; agent model calls pass one gate, so together they hold at most one of the shared LLM slots.
 */
import type { FunctionDeclaration } from "@google/genai";
import type { CallUser, ToolRegistry } from "@friday/sdk";
import { agentPrompt } from "../config.js";
import type { ConversationRecorder } from "../conversations/recorder.js";
import type { ConversationStore } from "../conversations/store.js";
import { Semaphore, type LlmService } from "../llm/service.js";
import { runToolLoop, type LoopCall, type LoopState } from "../llm/tool-loop.js";
import { AgentInputError, parseAgent, resolveTools, type AgentDefinition, type ToolMode } from "./definition.js";
import type { AgentAction, AgentRun, AgentRunStore, AgentStore, Decision, RunTrigger } from "./store.js";

/** The first message of a run without a request. */
export const START_MESSAGE = "Start your run now.";
/** A run's summary is the model's final answer, cut to this many characters. */
export const MAX_SUMMARY = 2000;
/** A request (run_agent, the portal) is at most this long. */
export const MAX_REQUEST = 2000;

export interface AgentRuntimeOptions {
  agents: AgentStore;
  runs: AgentRunStore;
  registry: ToolRegistry;
  conversations: ConversationStore;
  llm: Pick<LlmService, "streamCall">;
  /** The text model runs use (FRIDAY_TEXT_MODEL). */
  model: string;
  /** The household zone, read at each run start. */
  timezone: () => string;
  /** A tool call or approved action that has not settled after this long is answered with a timeout error. */
  toolTimeoutMs: number;
  /** Length of a budget minute; tests shorten it. */
  minuteMs?: number;
  now?: () => Date;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export type StartResult =
  | { ok: true; run: AgentRun; done: Promise<AgentRun> }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "busy"; since: string; runId: string };

export type DecideResult = { status: "ok"; action: AgentAction } | { status: Exclude<Decision, "ok"> };

interface Active {
  run: AgentRun;
  controller: AbortController;
  /** Why the signal was aborted. */
  reason?: "cancelled" | "time";
  done: Promise<AgentRun>;
}

export class AgentRuntime {
  private readonly active = new Map<string, Active>();
  /** Agent model calls take one slot of the shared bound at a time, so chat and modules keep the others. */
  private readonly gate = new Semaphore(1);
  private readonly log: Pick<Console, "log" | "warn" | "error">;
  private readonly now: () => Date;
  private readonly minuteMs: number;

  constructor(private readonly o: AgentRuntimeOptions) {
    this.log = o.log ?? console;
    this.now = o.now ?? (() => new Date());
    this.minuteMs = o.minuteMs ?? 60_000;
  }

  /** The run in progress for an agent, if any. */
  running(name: string): AgentRun | undefined {
    return this.active.get(name)?.run;
  }

  /**
   * Start a run in the background. Synchronous up to registering the run, so two starts can't both pass the
   * busy check. A stored definition that no longer validates gives a run that fails before any model call. However
   * it was started, the run acts for the agent's creator: its tool calls, its tools and its conversation are theirs.
   * Callers check that whoever asked is the creator.
   */
  start(name: string, trigger: RunTrigger, request?: string): StartResult {
    const busy = this.active.get(name);
    if (busy) return { ok: false, reason: "busy", since: busy.run.startedAt, runId: busy.run.id };
    const stored = this.o.agents.get(name);
    if (!stored) return { ok: false, reason: "unknown" };
    const text = request?.trim().slice(0, MAX_REQUEST) || undefined;
    const run = this.o.runs.start({ agent: name, trigger, request: text, userId: stored.createdBy?.id });
    const controller = new AbortController();
    const entry: Active = { run, controller, done: Promise.resolve(run) };
    entry.done = this.execute(stored, entry, text)
      .catch((e) => {
        this.log.error(`agents: run ${run.id} of ${name} failed`, e);
        return this.o.runs.finish(run.id, { outcome: "failed", error: e instanceof Error ? e.message : String(e), toolCalls: 0, tokens: 0 })!;
      })
      .finally(() => this.active.delete(name));
    this.active.set(name, entry);
    this.log.log(`agents: ${name} started (${trigger})`);
    return { ok: true, run, done: entry.done };
  }

  /** Cancel a running run; false when it isn't running. */
  cancel(runId: string): boolean {
    for (const a of this.active.values()) {
      if (a.run.id !== runId) continue;
      a.reason ??= "cancelled";
      a.controller.abort();
      return true;
    }
    return false;
  }

  /** Cancel every running run and wait for them to be recorded (shutdown, or an agent being deleted). */
  async stop(name?: string): Promise<void> {
    const runs = [...this.active.entries()].filter(([n]) => name === undefined || n === name).map(([, a]) => a);
    for (const a of runs) this.cancel(a.run.id);
    await Promise.all(runs.map((a) => a.done));
  }

  /**
   * Approve a pending action as `by`: execute exactly the stored call, with no model involved. The call is for the
   * user the run acted for (the agent's creator), like the run's own calls. Callers check that `by` is the creator.
   */
  async approve(actionId: string, by?: CallUser): Promise<DecideResult> {
    const decision = this.o.runs.claim(actionId, by?.id);
    if (decision !== "ok") return { status: decision };
    const action = this.o.runs.action(actionId)!;
    const run = this.o.runs.get(action.runId);
    const conversationId = run?.conversationId ?? undefined;
    let settled: AgentAction | undefined;
    if (!this.o.registry.declarations("agent", run?.user ?? undefined).some((d) => d.name === action.tool)) {
      settled = this.o.runs.settle(actionId, { state: "failed", error: `tool ${action.tool} is not available` });
    } else {
      const result = await this.callRegistry(action.tool, action.args, conversationId, undefined, run?.user ?? undefined);
      const error = typeof result.error === "string" ? result.error : undefined;
      settled = this.o.runs.settle(actionId, error ? { state: "failed", result, error } : { state: "executed", result });
    }
    // The agent (and with it the action) may have been deleted while the call ran.
    this.log.log(`agents: action ${actionId} (${action.tool}) approved: ${settled?.state ?? "ran, but its agent was deleted meanwhile"}`);
    return settled ? { status: "ok", action: settled } : { status: "missing" };
  }

  reject(actionId: string, by?: CallUser): DecideResult {
    const decision = this.o.runs.reject(actionId, by?.id);
    return decision === "ok" ? { status: "ok", action: this.o.runs.action(actionId)! } : { status: decision };
  }

  private async execute(stored: AgentDefinition, a: Active, request: string | undefined): Promise<AgentRun> {
    const { run } = a;
    let def: AgentDefinition;
    try {
      def = parseAgent(stored, stored.name);
    } catch (e) {
      const error = e instanceof AgentInputError ? `invalid definition: ${e.message}` : String(e);
      return this.o.runs.finish(run.id, { outcome: "failed", error, toolCalls: 0, tokens: 0 })!;
    }
    const user = run.user ?? undefined;
    const { tools } = resolveTools(def, this.o.registry, user);
    const declarations = this.o.registry.declarations("agent", user).filter((d) => tools.has(d.name)) as FunctionDeclaration[];
    const first = request ?? START_MESSAGE;
    const recorder = this.o.conversations.recorder({ channel: "agent", userId: run.user?.id ?? null }, this.log);
    recorder.user(first, "text");
    recorder.commitUser();
    const conversationId = recorder.conversationId;
    let state: LoopState = { rounds: 0, calls: 0, tokens: 0, streamed: false };
    const progress = () => this.o.runs.progress(run.id, { conversationId, toolCalls: state.calls, tokens: state.tokens });
    progress();

    const timer = setTimeout(() => {
      a.reason ??= "time";
      a.controller.abort();
    }, def.budgets.maxMinutes * this.minuteMs);
    try {
      const result = await runToolLoop({
        llm: this.o.llm,
        owner: `agent:${def.name}`,
        model: this.o.model,
        system: agentPrompt(def.name, def.instructions, this.now(), this.o.timezone()),
        contents: [{ role: "user", parts: [{ text: first }] }],
        tools: declarations,
        thoughts: false,
        signal: a.controller.signal,
        around: async (call) => {
          const release = await this.gate.acquire(a.controller.signal);
          try {
            return await call();
          } finally {
            release();
          }
        },
        onText: (text) => recorder.assistant(text),
        callTool: async (c) => {
          const handle = recorder.tool(c.name, c.args);
          const out = await this.callTool(def, tools.get(c.name), c, run, conversationId, a.controller.signal);
          handle.result(out);
          return out;
        },
        beforeRound: (s) => {
          state = s;
          progress();
          return s.tokens >= def.budgets.maxTokens ? { kind: "tokens", message: `the token budget (${def.budgets.maxTokens}) is used up` } : undefined;
        },
        // The round that crossed a budget doesn't get its calls run either.
        beforeCalls: (calls, s) => {
          if (s.tokens > def.budgets.maxTokens) return { kind: "tokens", message: `the token budget (${def.budgets.maxTokens}) is used up` };
          if (s.calls + calls.length > def.budgets.maxToolCalls) return { kind: "tool_calls", message: `the tool call budget (${def.budgets.maxToolCalls}) is used up` };
          return undefined;
        },
      });
      state = result.state;
      const { outcome } = result;
      const used = { toolCalls: state.calls, tokens: state.tokens, conversationId };
      if (outcome.kind === "done") {
        recorder.end("done");
        return this.finish(run, { outcome: "ok", summary: outcome.text.trim().slice(0, MAX_SUMMARY) || undefined, ...used });
      }
      if (outcome.kind === "stopped") {
        for (const c of outcome.unrun) recorder.tool(c.name, c.args).result({ error: `not run: ${outcome.stop.message}` });
        recorder.end("budget exceeded");
        return this.finish(run, { outcome: "budget_exceeded", summary: `Stopped: ${outcome.stop.message}.`, ...used });
      }
      if (state.streamed) recorder.interrupted();
      if (outcome.kind === "aborted") {
        if (a.reason === "time") {
          recorder.end("budget exceeded");
          return this.finish(run, { outcome: "budget_exceeded", summary: `Stopped: the time budget (${def.budgets.maxMinutes} minutes) is used up.`, ...used });
        }
        recorder.end("cancelled");
        return this.finish(run, { outcome: "cancelled", ...used });
      }
      recorder.end("failed");
      const error = outcome.kind === "failed" ? `${outcome.error.kind}: ${outcome.error.message}` : outcome.message;
      return this.finish(run, { outcome: "failed", error, ...used });
    } finally {
      clearTimeout(timer);
      recorder.release();
    }
  }

  private finish(run: AgentRun, f: Parameters<AgentRunStore["finish"]>[1]): AgentRun {
    const done = this.o.runs.finish(run.id, f)!;
    this.log.log(`agents: ${run.agent} ${done.outcome} (${f.toolCalls} tool calls, ${f.tokens} tokens)`);
    return done;
  }

  /** One call of a run: refused outside the agent's tools, parked for `approve`, run (timed out, cancellable) for `auto`. */
  private async callTool(def: AgentDefinition, mode: ToolMode | undefined, c: LoopCall, run: AgentRun, conversationId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!mode) return { error: `tool ${c.name} is not available to this agent` };
    if (mode === "approve") {
      const action = this.o.runs.park({ runId: run.id, agent: def.name, tool: c.name, args: c.args });
      return { queued: true, actionId: action.id, note: "Queued for the user's approval. It has not run; continue without its result." };
    }
    return this.callRegistry(c.name, c.args, conversationId, signal, run.user ?? undefined);
  }

  private async callRegistry(name: string, args: Record<string, unknown>, conversationId: string | undefined, signal?: AbortSignal, user?: CallUser): Promise<Record<string, unknown>> {
    const ms = this.o.toolTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const call = this.o.registry.callTool(name, args, { channel: "agent", ...(conversationId ? { conversationId } : {}), ...(user ? { user } : {}) });
    const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)));
    const aborted = new Promise<"aborted">((r) => {
      onAbort = () => r("aborted");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([call, timedOut, aborted]);
      if (outcome === "timeout") {
        void call.then(() => this.log.warn(`agents: tool ${name} settled after its ${ms} ms timeout; result dropped`));
        return { error: `timed out after ${ms} ms` };
      }
      if (outcome === "aborted") return { error: "not finished: the run was stopped" };
      return outcome.result;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
}
