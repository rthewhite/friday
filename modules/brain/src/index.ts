/**
 * The brain: Friday's long-term memory for the household. Pages about people, places and projects
 * plus one profile, with full revisions, `[[links]]` and tombstones for forgotten names. Friday
 * reads it through the prompt context and `brain_recall`, and adds to it with `brain_remember`;
 * the user curates it at /m/brain. The `brain/nightly` job notes facts from finished conversations
 * and tidies the pages.
 */
import { DEFAULT_TIME_ZONE, defineModule, householdTimeZone, localDate } from "@friday/sdk";
import { renderContext } from "./context.js";
import { runConsolidate } from "./nightly/consolidate.js";
import { runExtract } from "./nightly/extract.js";
import { DEFAULT_NIGHTLY_CRON, scheduleNightly, type NightlySteps } from "./nightly/job.js";
import { registerRunRoutes } from "./nightly/review.js";
import { RunStore } from "./nightly/runs.js";
import { registerBrainRoutes } from "./routes.js";
import { migrations } from "./schema.js";
import { BrainStore } from "./store.js";
import { defineBrainTools } from "./tools.js";

export { BrainStore, BrainError, appendUnderNotes, validateFields } from "./store.js";
export type { Page, PageFields, PageType, Author, Revision, RememberResult } from "./store.js";
export { renderContext } from "./context.js";
export { recall } from "./tools.js";

export const DEFAULT_PROFILE_BUDGET = 800;
export const DEFAULT_NIGHTLY_MAX_CONVERSATIONS = 30;

export interface BrainOptions {
  /** Clock for timestamps and note dates (tests inject one). */
  now?: () => Date;
}

export function createBrainModule(opts: BrainOptions = {}) {
  const now = opts.now ?? (() => new Date());
  return defineModule({
    manifest: {
      id: "brain",
      label: "Brain",
      description: "Long-term memory: pages about the people, places and projects in the household, plus a profile.",
      ui: true,
      config: [
        { key: "BRAIN_PROFILE_TOKEN_BUDGET", description: `Soft token budget for the profile, estimated as characters / 4 (default ${DEFAULT_PROFILE_BUDGET})` },
        { key: "FRIDAY_TIMEZONE", description: `IANA zone for the dates on notes (default ${DEFAULT_TIME_ZONE})` },
        { key: "BRAIN_NIGHTLY_CRON", description: `When the nightly maintenance runs, as a cron expression in FRIDAY_TIMEZONE (default ${DEFAULT_NIGHTLY_CRON}); "off" disables it. Read at load.` },
        { key: "BRAIN_NIGHTLY_MAX_CONVERSATIONS", description: `Conversations the nightly pass reads per run (default ${DEFAULT_NIGHTLY_MAX_CONVERSATIONS})` },
      ],
    },
    migrations,
    init(ctx) {
      const store = new BrainStore(ctx.db, { now });
      const runs = new RunStore(ctx.db, now, () => store.lastRevisionId());
      const budget = () => {
        const n = Math.floor(Number(ctx.config.get("BRAIN_PROFILE_TOKEN_BUDGET")));
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROFILE_BUDGET;
      };
      const zone = householdTimeZone(ctx.config, (m) => ctx.log.warn(m));
      const today = () => localDate(now(), zone());
      const maxConversations = () => {
        const n = Math.floor(Number(ctx.config.get("BRAIN_NIGHTLY_MAX_CONVERSATIONS")));
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_NIGHTLY_MAX_CONVERSATIONS;
      };
      const extractDeps = { store, conversations: ctx.conversations, llm: ctx.llm, storage: ctx.storage, log: ctx.log, maxConversations, zone };
      const steps: NightlySteps = {
        extract: (signal) => runExtract(extractDeps, signal),
        consolidate: (signal) => runConsolidate({ store, db: ctx.db, llm: ctx.llm, storage: ctx.storage, log: ctx.log, budget }, signal),
      };
      defineBrainTools(ctx, store, today, zone);
      registerBrainRoutes(ctx, store, budget);
      registerRunRoutes(ctx, store, runs);
      scheduleNightly(ctx, runs, steps);
      ctx.prompt.addContext(() => renderContext(store));
    },
  });
}

export default createBrainModule();
