/**
 * The `brain/nightly` job (design D1): extract notes from finished conversations, consolidate pages, then
 * generate the profile summary from them (hybrid-profile D5), recorded as one run in `brain__runs`.
 */
import type { JobTrigger, ModuleContext } from "@friday/sdk";
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
    // A refused plan leaves the pages as they were; the summary still follows them. A cancelled run stops here.
    if (c && !(signal.aborted || c.failed === "cancelled")) s = await steps.summary(signal);
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

/**
 * Schedules `nightly` from BRAIN_NIGHTLY_CRON (read at init; `off` disables it). An invalid expression
 * disables only the job, with an error in the log: the brain itself (tools, context, portal) still loads.
 */
export function scheduleNightly(ctx: ModuleContext, runs: RunStore, steps: NightlySteps): void {
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
      async run({ signal, trigger }) {
        const { summary } = await runNightly(runs, steps, trigger, signal);
        return { summary };
      },
    });
  } catch (e) {
    ctx.log.error(`nightly maintenance is disabled: ${e instanceof Error ? e.message : String(e)} (fix BRAIN_NIGHTLY_CRON and reload the module)`);
  }
}
