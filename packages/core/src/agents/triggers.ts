/**
 * How agents start besides the portal: a core job `agent-<name>` per enabled agent with a schedule, and the
 * core-owned `run_agent` tool for voice and chat, starting one of the caller's enabled agents marked startable. Both
 * are rebuilt whenever an agent changes. `run_agent` is never offered to agents, so an agent can't start one.
 *
 * Agents are private to their creator. The job records only a run's outcome, never the agent's answer, since the
 * Jobs page is the admins'. `run_agent`'s declaration, which every user's sessions see, names no agent: the prompt
 * context lists the prompt user's own.
 */
import { Type, type CallUser, type JobContext, type ModulePrompt, type ToolCallContext, type ToolRegistry } from "@friday/sdk";
import { CORE_ID } from "../core-config.js";
import type { Scheduler } from "../jobs/scheduler.js";
import type { JobStore } from "../jobs/store.js";
import { MAX_REQUEST, type AgentRuntime } from "./runtime.js";
import type { AgentStore, StoredAgent } from "./store.js";

export const RUN_AGENT = "run_agent";
export const AGENT_JOB_PREFIX = "agent-";
export const jobName = (agent: string) => `${AGENT_JOB_PREFIX}${agent}`;
const jobId = (agent: string) => `${CORE_ID}/${jobName(agent)}`;

export interface AgentTriggersOptions {
  agents: AgentStore;
  runtime: Pick<AgentRuntime, "start" | "cancel">;
  registry: ToolRegistry;
  scheduler: Pick<Scheduler, "register" | "unregister">;
  jobs: Pick<JobStore, "clearState" | "deleteRuns">;
  /** The household zone, for "running since HH:MM". */
  timezone: () => string;
  /** Core's prompt context, where each user's startable agents are listed. Without it, they are listed nowhere. */
  prompt?: ModulePrompt;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export class AgentTriggers {
  /** The schedule each agent's job was registered with. */
  private readonly scheduled = new Map<string, string>();
  private readonly log: Pick<Console, "log" | "warn" | "error">;
  private unsubscribe?: () => void;
  private removeContext?: () => void;

  constructor(private readonly o: AgentTriggersOptions) {
    this.log = o.log ?? console;
  }

  /** Register every agent's job and `run_agent`, and follow changes from now on. */
  start(): void {
    // At startup the stored due times stand, so a run missed while Friday was down catches up once.
    for (const a of this.o.agents.list()) this.syncJob(a.name, a, { boot: true });
    this.syncTool();
    this.removeContext = this.o.prompt?.addContext(({ user }) => this.context(user));
    this.unsubscribe = this.o.agents.onChange((name) => {
      this.syncJob(name, this.o.agents.get(name));
      this.syncTool();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.removeContext?.();
    for (const name of this.scheduled.keys()) this.o.scheduler.unregister(jobId(name));
    this.scheduled.clear();
    this.o.registry.remove(RUN_AGENT);
  }

  private syncJob(name: string, agent: StoredAgent | undefined, o: { boot?: boolean } = {}): void {
    const before = this.scheduled.get(name);
    this.o.scheduler.unregister(jobId(name));
    this.scheduled.delete(name);
    if (!agent) {
      this.o.jobs.clearState(jobId(name));
      this.o.jobs.deleteRuns(jobId(name));
      return;
    }
    if (!agent.enabled || !agent.schedule) return;
    // An edit that changes the schedule, or enables the agent again, starts afresh: an old due time must not make
    // the job catch up a slot of the old schedule or one missed while the agent was disabled.
    if (!o.boot && before !== agent.schedule) this.o.jobs.clearState(jobId(name));
    try {
      this.o.scheduler.register(CORE_ID, {
        name: jobName(name),
        description: `Agent ${name}: ${agent.description}`,
        cron: agent.schedule,
        run: (job) => this.runJob(name, job),
      });
      this.scheduled.set(name, agent.schedule);
    } catch (e) {
      this.log.error(`agents: could not schedule ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * A job run is an agent run, acting for the agent's creator. The job's record mirrors its outcome, and only that:
   * the answer and error are the creator's to read, on the Agents page.
   */
  private async runJob(name: string, job: JobContext): Promise<{ summary: string }> {
    const r = this.o.runtime.start(name, job.trigger === "manual" ? "portal" : "schedule");
    if (!r.ok) {
      if (r.reason === "busy") return { summary: `already running since ${this.clock(r.since)}` };
      throw new Error(`agent ${name} is gone`);
    }
    const cancel = () => this.o.runtime.cancel(r.run.id);
    job.signal.addEventListener("abort", cancel, { once: true });
    try {
      const run = await r.done;
      if (run.outcome === "ok") return { summary: "ok" };
      throw new Error(run.outcome);
    } finally {
      job.signal.removeEventListener("abort", cancel);
    }
  }

  private syncTool(): void {
    this.o.registry.remove(RUN_AGENT);
    if (!this.startable().length) return;
    this.o.registry.add(CORE_ID, {
      name: RUN_AGENT,
      description:
        "Start one of the user's agents when the user asks to run it; their agents are listed in your instructions. " +
        "The agent runs in the background; this tool does not return its result (an agent reports in its own way). " +
        "Tell the user it started.",
      channels: ["voice", "chat"],
      parameters: {
        type: Type.OBJECT,
        properties: {
          agent: { type: Type.STRING, description: "The name of the agent to start" },
          request: { type: Type.STRING, description: "What the user asked the agent to do this time, if anything beyond its usual job" },
        },
        required: ["agent"],
      },
      handler: (args: { agent?: unknown; request?: unknown }, call: ToolCallContext) => this.runAgent(args, call),
    });
  }

  private runAgent(args: { agent?: unknown; request?: unknown }, call: ToolCallContext): Record<string, unknown> {
    const name = typeof args.agent === "string" ? args.agent : "";
    // Another user's agent is as unknown as a missing one.
    if (!this.startable(call.user ?? null).some((a) => a.name === name)) return { error: `there is no agent "${name}" that can be started by voice or chat` };
    if (args.request !== undefined && typeof args.request !== "string") return { error: "request must be text" };
    if (typeof args.request === "string" && args.request.length > MAX_REQUEST) return { error: `request is longer than ${MAX_REQUEST} characters` };
    // Started by its creator in chat, the Talk page or a device (which acts for the owner); it runs as them.
    const r = this.o.runtime.start(name, call.channel === "chat" ? "chat" : "voice", args.request);
    if (!r.ok) return r.reason === "busy" ? { error: `${name} is already running, since ${this.clock(r.since)}` } : { error: `there is no agent "${name}"` };
    return { started: true, agent: name, note: "It runs in the background; its result is not returned here." };
  }

  /** Enabled agents marked startable: everyone's (whether `run_agent` exists at all), or one user's. */
  private startable(user?: CallUser | null): StoredAgent[] {
    if (user === undefined) return this.o.agents.list().filter((a) => a.enabled && a.startable);
    return user ? this.o.agents.list(user.id).filter((a) => a.enabled && a.startable) : [];
  }

  /** The prompt user's agents `run_agent` can start, or nothing. */
  private context(user: CallUser | undefined): string | undefined {
    const mine = this.startable(user ?? null);
    if (!mine.length) return undefined;
    return `## Agents\nThe user's agents you can start with ${RUN_AGENT}:\n${mine.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`;
  }

  private clock(iso: string): string {
    return new Intl.DateTimeFormat("en-GB", { timeZone: this.o.timezone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  }
}
