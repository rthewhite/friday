/**
 * The `brain/nightly` job (design D1): extract notes from finished conversations, then consolidate
 * pages, recorded as one run in `brain__runs`.
 */
import type { JobTrigger, ModuleContext } from "@friday/sdk";
import type { DroppedLine, MergeRecord, Run, RunOutcome, RunStore } from "./runs.js";

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
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `5 conversations (2 trivial), 4 notes; 3 pages rewritten, 1 merge, 2 lines dropped`. */
export function summarize(e: ExtractOutcome, c: ConsolidateOutcome | undefined, outcome: RunOutcome, error?: string): string {
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
  const text = `${extract}; ${consolidate}${outcome === "ok" ? "" : ` [${outcome}${error ? `: ${error}` : ""}]`}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/** One run: extract, then consolidate unless extraction was stopped; always finishes the run row. */
export async function runNightly(runs: RunStore, steps: NightlySteps, trigger: JobTrigger, signal: AbortSignal): Promise<{ run: Run; summary: string }> {
  const run = runs.start(trigger);
  let e: ExtractOutcome = { conversations: 0, skipped: 0, notes: 0, refused: 0, errors: [] };
  let c: ConsolidateOutcome | undefined;
  try {
    e = await steps.extract(signal);
    if (!e.stopped) c = await steps.consolidate(signal);
    const problems = [e.stopped, ...e.errors, c?.failed].filter((x): x is string => !!x);
    const outcome: RunOutcome = e.stopped || c?.failed ? "partial" : "ok";
    const error = problems.length ? problems.join("; ") : undefined;
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
      error,
    });
    return { run: finished, summary: summarize(e, c, outcome, error) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runs.finish(run.id, { outcome: "failed", conversations: e.conversations, skipped: e.skipped, notes: e.notes, refused: e.refused, error: message });
    throw err;
  }
}

/** Schedules `nightly` from BRAIN_NIGHTLY_CRON (read at init; `off` disables it). */
export function scheduleNightly(ctx: ModuleContext, runs: RunStore, steps: NightlySteps): void {
  const cron = (ctx.config.get("BRAIN_NIGHTLY_CRON") ?? "").trim() || DEFAULT_NIGHTLY_CRON;
  if (cron.toLowerCase() === "off") {
    ctx.log.log("nightly maintenance is off (BRAIN_NIGHTLY_CRON=off)");
    return;
  }
  ctx.jobs.schedule({
    name: "nightly",
    description: "Notes lasting facts from finished conversations, then tidies the brain's pages",
    cron,
    timeoutMs: NIGHTLY_TIMEOUT_MS,
    async run({ signal, trigger }) {
      const { summary } = await runNightly(runs, steps, trigger, signal);
      return { summary };
    },
  });
}
