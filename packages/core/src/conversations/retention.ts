/** The nightly `core/conversation-retention` job: deletes conversations inactive for longer than the retention period. */
import type { JobSpec } from "@friday/sdk";
import type { Scheduler } from "../jobs/scheduler.js";
import type { ConversationStore } from "./store.js";

const DAY_MS = 86_400_000;

export function retentionJob(store: ConversationStore, days: number): JobSpec {
  return {
    name: "conversation-retention",
    description: `Delete conversations with no activity for more than ${days} days`,
    // 04:00 leaves 03:00 free for nightly passes that read conversations first.
    cron: "0 4 * * *",
    async run({ signal }) {
      const cutoff = new Date(store.now().getTime() - days * DAY_MS);
      let deleted = 0;
      while (!signal.aborted) {
        const n = store.prune(cutoff);
        if (!n) break;
        deleted += n;
        await new Promise((r) => setImmediate(r)); // let other work (and an abort) in between batches
      }
      return { summary: `deleted ${deleted} conversation${deleted === 1 ? "" : "s"}` };
    },
  };
}

/** Registers the retention job as a `core` job unless retention is disabled (0 keeps conversations forever). */
export function registerRetention(jobs: Scheduler, store: ConversationStore, days: number): boolean {
  if (!(days > 0)) return false;
  jobs.register("core", retentionJob(store, days));
  return true;
}
