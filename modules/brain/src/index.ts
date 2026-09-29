/**
 * The brain: Friday's long-term memory for the household. Pages about people, places and projects
 * plus one profile, with full revisions, `[[links]]` and tombstones for forgotten names. Friday
 * reads it through the prompt context and `brain_recall`, and adds to it with `brain_remember`;
 * the user curates it at /m/brain.
 */
import { defineModule } from "@friday/sdk";
import { renderContext } from "./context.js";
import { registerBrainRoutes } from "./routes.js";
import { migrations } from "./schema.js";
import { BrainStore } from "./store.js";
import { defineBrainTools } from "./tools.js";

export { BrainStore, BrainError, appendUnderNotes, validateFields } from "./store.js";
export type { Page, PageFields, PageType, Author, Revision, RememberResult } from "./store.js";
export { renderContext } from "./context.js";
export { recall } from "./tools.js";

export const DEFAULT_PROFILE_BUDGET = 800;
export const DEFAULT_TIMEZONE = "Europe/Amsterdam";

export interface BrainOptions {
  /** Clock for timestamps and note dates (tests inject one). */
  now?: () => Date;
}

/** `YYYY-MM-DD` of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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
        { key: "FRIDAY_TIMEZONE", description: `IANA zone for the dates on remembered notes (default ${DEFAULT_TIMEZONE})` },
      ],
    },
    migrations,
    init(ctx) {
      const store = new BrainStore(ctx.db, { now });
      const budget = () => {
        const n = Math.floor(Number(ctx.config.get("BRAIN_PROFILE_TOKEN_BUDGET")));
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROFILE_BUDGET;
      };
      const today = () => {
        const zone = ctx.config.get("FRIDAY_TIMEZONE") || DEFAULT_TIMEZONE;
        try {
          return localDate(now(), zone);
        } catch {
          ctx.log.warn(`FRIDAY_TIMEZONE ${JSON.stringify(zone)} is not a valid zone; dating notes in ${DEFAULT_TIMEZONE}`);
          return localDate(now(), DEFAULT_TIMEZONE);
        }
      };
      defineBrainTools(ctx, store, today);
      registerBrainRoutes(ctx, store, budget);
      ctx.prompt.addContext(() => renderContext(store));
    },
  });
}

export default createBrainModule();
