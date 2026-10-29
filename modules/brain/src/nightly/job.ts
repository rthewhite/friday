/**
 * The `brain/nightly` job (design D1): extract notes from finished conversations, consolidate pages, then
 * generate the profile summary from them (hybrid-profile D5), recorded as one run in `brain__runs`. It runs once
 * per user, over that user's conversations and brain (user-privacy); the job's own summary holds counts only.
 */
import type { CallUser, JobTrigger, ModuleContext } from "@friday/sdk";
import type { DroppedLine, MergeRecord, Run, RunOutcome, RunStore } from "./runs.js";
import type { SummaryOutcome } from "./summary.js";

export const DEFAULT_NIGHTLY_CRON = "0 3 * * *";
export const NIGHTLY_TIMEOUT_MS = 30 * 60_000;

export interface ExtractOutcome {
  conversations: number;
  skipped: number;
  notes: number;
  refused: number;
  /** Set when the step stopped early (model unavailable, cancelled): the run is `partial`. */
  stopped?: string;
  /** Conversations given up on after 3 failed attempts. */
  errors: string[];
}

export interface ConsolidateOutcome {
  /** False when no page changed since the last consolidation (no model call). */
  ran: boolean;
  rewrites: number;
  creates: number;
  merges: MergeRecord[];
  dropped: DroppedLine[];
  /** Set when no plan was applied (refused twice, model unavailable, cancelled): the run is `partial`. */
  failed?: string;
}

export interface NightlySteps {
  extract(signal: AbortSignal): Promise<ExtractOutcome>;
  consolidate(signal: AbortSignal): Promise<ConsolidateOutcome>;
  summary(signal: AbortSignal): Promise<SummaryOutcome>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `5 conversations (2 trivial), 4 notes; 3 pages rewritten, 1 merge, 2 lines dropped; summary generated`. */
export function summarize(e: ExtractOutcome, c: ConsolidateOutcome | undefined, outcome: RunOutcome, error?: string, s?: SummaryOutcome): string {
  const extract = `${plural(e.conversations, "conversation")} (${e.skipped} trivial), ${plural(e.notes, "note")}${e.refused ? ` (${e.refused} refused)` : ""}`;
  let consolidate = "not consolidated";
  if (c && !c.ran) consolidate = "nothing to consolidate";
  else if (c && c.failed) consolidate = "no consolidation applied";
  else if (c) {
    const parts = [`${plural(c.rewrites, "page")} rewritten`];
    if (c.creates) parts.push(`${plural(c.creates, "page")} created`);
    parts.push(plural(c.merges.length, "merge"), `${plural(c.dropped.length, "line")} dropped`);
    consolidate = parts.join(", ");
  }
  const summary = s?.generated ? "; summary generated" : s?.failed ? "; summary not generated" : "";
  const text = `${extract}; ${consolidate}${summary}${outcome === "ok" ? "" : ` [${outcome}${error ? `: ${error}` : ""}]`}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/**
 * One run: extract, then consolidate and generate the summary unless extraction was stopped (the model is
 * unavailable or the run cancelled); always finishes the run row.
 */
export async function runNightly(runs: RunStore, steps: NightlySteps, trigger: JobTrigger, signal: AbortSignal): Promise<{ run: Run; summary: string }> {
  const run = runs.start(trigger);
  let e: ExtractOutcome = { conversations: 0, skipped: 0, notes: 0, refused: 0, errors: [] };
  let c: ConsolidateOutcome | undefined;
  let s: SummaryOutcome | undefined;
  try {
    e = await steps.extract(signal);
    if (!e.stopped) c = await steps.consolidate(signal);
    // A refused plan leaves the pages as they were; the summary still follows them. A cancelled run, or one
    // whose model is unavailable ("model unavailable: …"), stops here: outages wait for the next run.
    if (c && !(signal.aborted || c.failed === "cancelled" || c.failed?.startsWith("model "))) s = await steps.summary(signal);
    const problems = [e.stopped, ...e.errors, c?.failed, s?.failed].filter((x): x is string => !!x);
    const outcome: RunOutcome = e.stopped || c?.failed || s?.failed ? "partial" : "ok";
    const error = problems.length ? problems.join("; ") : undefined;
    const summary = summarize(e, c, outcome, error, s);
    const finished = runs.finish(run.id, {
      outcome,
      conversations: e.conversations,
      skipped: e.skipped,
      notes: e.notes,
      refused: e.refused,
      rewrites: c?.rewrites ?? 0,
      creates: c?.creates ?? 0,
      mergeRecords: c?.merges ?? [],
      dropped: c?.dropped ?? [],
      summaryGenerated: s?.generated ?? false,
      error,
      summary,
    });
    return { run: finished, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runs.finish(run.id, { outcome: "failed", conversations: e.conversations, skipped: e.skipped, notes: e.notes, refused: e.refused, error: message, summary: `failed: ${message}`.slice(0, 500) });
    throw err;
  }
}

/** One user's pass: their runs and the steps over their conversations and brain. */
export interface UserPass {
  runs: RunStore;
  steps: NightlySteps;
}

/** Users whose pass is running, so the job and `Run it now` never run one user's pass twice at once. */
export class PassGuard {
  private readonly running = new Set<string>();

  isRunning(userId: string): boolean {
    return this.running.has(userId);
  }

  /** Runs `fn` as `userId`'s pass; undefined, without running it, when one is already running. */
  async run<T>(userId: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.running.has(userId)) return undefined;
    this.running.add(userId);
    try {
      return await fn();
    } finally {
      this.running.delete(userId);
    }
  }
}

/**
 * Every user's pass in turn, the user whose brain waited longest first (never run, then oldest last run), so a job
 * that runs out of time leaves a different user for the next night rather than the same one every night. A user
 * whose pass throws is recorded as failed in their own brain and the others still run; the job then reports
 * `partial` in its summary, and fails when every user's pass failed. The summary holds counts only.
 */
export async function runNightlyForUsers(
  users: CallUser[],
  passOf: (user: CallUser) => UserPass,
  guard: PassGuard,
  trigger: JobTrigger,
  signal: AbortSignal,
  log: Pick<Console, "error"> = console,
): Promise<{ summary: string; runs: Run[] }> {
  const runs: Run[] = [];
  let failed = 0;
  let busy = 0;
  const passes = users.map((user) => ({ user, pass: passOf(user) }));
  const lastRun = (p: UserPass) => p.runs.list(1)[0]?.startedAt ?? "";
  passes.sort((a, b) => lastRun(a.pass).localeCompare(lastRun(b.pass)));
  for (const { user, pass } of passes) {
    if (signal.aborted) break;
    try {
      const r = await guard.run(user.id, () => runNightly(pass.runs, pass.steps, trigger, signal));
      if (r) runs.push(r.run);
      else busy++;
    } catch (e) {
      failed++;
      log.error(`nightly pass failed for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const summary = summarizeUsers(users.length, runs, failed, busy);
  if (users.length && failed === users.length) throw new Error(summary);
  return { summary, runs };
}

/** `partial: 1 of 2 users failed; 2 users: 5 conversations (2 trivial), 4 notes; 3 pages rewritten, 1 merge; 2 summaries generated`. */
export function summarizeUsers(users: number, runs: Run[], failed: number, busy = 0): string {
  const sum = (k: "conversations" | "skipped" | "notes" | "rewrites" | "creates" | "merges") => runs.reduce((n, r) => n + r[k], 0);
  const notOk = failed + runs.filter((r) => r.outcome !== "ok").length;
  const head = notOk ? `partial: ${notOk} of ${users} ${users === 1 ? "user" : "users"} failed; ` : "";
  const pages = [`${plural(sum("rewrites"), "page")} rewritten`];
  if (sum("creates")) pages.push(`${plural(sum("creates"), "page")} created`);
  pages.push(plural(sum("merges"), "merge"));
  const summaries = runs.filter((r) => r.summaryGenerated).length;
  const tail = [summaries ? `${plural(summaries, "summary", "summaries")} generated` : "", busy ? `${busy} already running` : ""].filter(Boolean).join("; ");
  return `${head}${plural(users, "user")}: ${plural(sum("conversations"), "conversation")} (${sum("skipped")} trivial), ${plural(sum("notes"), "note")}; ${pages.join(", ")}${tail ? `; ${tail}` : ""}`;
}

/**
 * Schedules `nightly` from BRAIN_NIGHTLY_CRON (read at init; `off` disables it). An invalid expression
 * disables only the job, with an error in the log: the brain itself (tools, context, portal) still loads.
 */
export function scheduleNightly(ctx: ModuleContext, passOf: (user: CallUser) => UserPass, guard: PassGuard): void {
  const cron = (ctx.config.get("BRAIN_NIGHTLY_CRON") ?? "").trim() || DEFAULT_NIGHTLY_CRON;
  if (cron.toLowerCase() === "off") {
    ctx.log.log("nightly maintenance is off (BRAIN_NIGHTLY_CRON=off)");
    return;
  }
  try {
    ctx.jobs.schedule({
      name: "nightly",
      description: "Notes lasting facts from finished conversations, tidies the brain's pages, then writes the profile summary",
      cron,
      timeoutMs: NIGHTLY_TIMEOUT_MS,
      async run({ signal, trigger, log }) {
        const { summary } = await runNightlyForUsers(ctx.users.list(), passOf, guard, trigger, signal, log);
        return { summary };
      },
    });
  } catch (e) {
    ctx.log.error(`nightly maintenance is disabled: ${e instanceof Error ? e.message : String(e)} (fix BRAIN_NIGHTLY_CRON and reload the module)`);
  }
}
