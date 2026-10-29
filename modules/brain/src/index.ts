/**
 * The brain: Friday's long-term memory, one per user. Pages about the people, places, projects, hobbies,
 * belongings and pets in that user's life, one of them the user's own, plus the profile: the user's
 * instructions and a summary generated from the pages. Full revisions, `[[links]]` and tombstones for
 * forgotten names. Friday reads the user's brain through the prompt context and `brain_recall`, and adds to it
 * with `brain_remember`; each user curates their own at /m/brain. The `brain/nightly` job notes facts from each
 * user's finished conversations, tidies their pages and writes their summary. No user's brain is visible to
 * another, admins included; a call or prompt without a user (none remain once devices act for the owner) uses
 * the household owner's.
 */
import { DEFAULT_TIME_ZONE, defineModule, householdTimeZone, localDate, type CallUser, type ToolCallContext } from "@friday/sdk";
import { renderContext } from "./context.js";
import { runConsolidate } from "./nightly/consolidate.js";
import { runExtract } from "./nightly/extract.js";
import { DEFAULT_NIGHTLY_CRON, PassGuard, runNightly, scheduleNightly, type UserPass } from "./nightly/job.js";
import { registerRunRoutes } from "./nightly/review.js";
import { RunStore } from "./nightly/runs.js";
import { runSummary } from "./nightly/summary.js";
import { registerBrainRoutes, requestBrain } from "./routes.js";
import { migrations } from "./schema.js";
import { BrainError } from "./store.js";
import { defineBrainTools } from "./tools.js";
import { assignToOwner, Brains, userStorage } from "./users.js";

export { BrainStore, BrainError, appendUnderNotes, validateFields } from "./store.js";
export { Brains, userStorage, assignToOwner } from "./users.js";
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
      description: "Long-term memory: pages about the people, places, projects, hobbies and belongings in the household, plus a profile with your instructions and a generated summary.",
      ui: true,
      config: [
        { key: "BRAIN_PROFILE_TOKEN_BUDGET", description: `Token budget for the generated profile summary, estimated as characters / 4 (default ${DEFAULT_PROFILE_BUDGET})` },
        { key: "FRIDAY_TIMEZONE", description: `IANA zone for the dates on notes (default ${DEFAULT_TIME_ZONE})` },
        { key: "BRAIN_NIGHTLY_CRON", description: `When the nightly maintenance runs, as a cron expression in FRIDAY_TIMEZONE (default ${DEFAULT_NIGHTLY_CRON}); "off" disables it. Read at load.` },
        { key: "BRAIN_NIGHTLY_MAX_CONVERSATIONS", description: `Conversations the nightly pass reads per run (default ${DEFAULT_NIGHTLY_MAX_CONVERSATIONS})` },
      ],
    },
    migrations,
    init(ctx) {
      const brains = new Brains(ctx.db, { now });
      // What was stored before brains had a user is the owner's: assigned now when there is one, else once the
      // first admin logs in. Assignment runs before anything reads a brain, so the owner never gets a new, empty one.
      const assign = (owner: CallUser) => assignToOwner(ctx.db, ctx.storage, owner, ctx.log).catch((e) => ctx.log.error(`assigning the brain to the owner failed: ${e instanceof Error ? e.message : String(e)}`));
      const owner = ctx.users.owner();
      const assigned = owner ? assign(owner) : Promise.resolve();
      ctx.users.onOwner((o) => assign(o).then(() => undefined));

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
      /** A user's nightly pass: their conversations, brain, storage keys and runs. */
      const passOf = (user: CallUser): UserPass => {
        const store = brains.forUser(user);
        const storage = userStorage(ctx.storage, user.id);
        const runs = new RunStore(ctx.db, user.id, now);
        const conversations = ctx.conversations.forUser(user.id);
        return {
          runs,
          steps: {
            extract: (signal) => runExtract({ store, conversations, llm: ctx.llm, storage, log: ctx.log, maxConversations, zone }, signal),
            consolidate: (signal) => runConsolidate({ store, db: ctx.db, llm: ctx.llm, storage, log: ctx.log }, signal),
            summary: (signal) => runSummary({ store, llm: ctx.llm, storage, log: ctx.log, budget }, signal),
          },
        };
      };
      const guard = new PassGuard();
      /** Whose brain a tool call or prompt is for: its user, else the household owner. */
      const userOf = (user: CallUser | undefined) => user ?? ctx.users.owner();
      const brainOf = (call: ToolCallContext) => {
        const user = userOf(call.user);
        return user && { user, store: brains.forUser(user) };
      };

      defineBrainTools(ctx, brainOf, today, zone);
      registerBrainRoutes(ctx, requestBrain((u) => brains.forUser(u)), budget);
      registerRunRoutes(ctx, (req) => {
        if (!req.user) throw new BrainError("not_found", "the brain needs a logged-in user");
        return { store: brains.forUser(req.user), runs: new RunStore(ctx.db, req.user.id, now), conversations: ctx.conversations.forUser(req.user.id) };
      });
      // Run it now, for the requesting user's brain only; any user may, and only one pass per user at a time.
      ctx.http.route("POST", "runs/now", async (req, res) => {
        const user = req.user;
        if (!user) return void res.status(404).json({ error: "the brain needs a logged-in user", code: "not_found" });
        if (guard.isRunning(user.id)) return void res.status(409).json({ error: "a nightly pass for your brain is already running", code: "running" });
        const pass = passOf(user);
        void guard.run(user.id, () => runNightly(pass.runs, pass.steps, "manual", new AbortController().signal)).catch((e) =>
          ctx.log.error(`nightly pass for user ${user.id} failed: ${e instanceof Error ? e.message : String(e)}`));
        res.status(202).json({ started: true });
      });
      scheduleNightly(ctx, passOf, guard);
      ctx.prompt.addContext(({ user }) => {
        const u = userOf(user);
        return u ? renderContext(brains.forUser(u)) : undefined;
      });
      return assigned.then(() => undefined);
    },
  });
}

export default createBrainModule();
