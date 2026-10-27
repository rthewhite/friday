/**
 * The nightly `core/oauth-keepalive` job: refreshes every connected login, used or not, so providers that drop idle
 * refresh tokens (Google, Microsoft) don't, and a login revoked at the provider shows up as `error` within a day.
 */
import type { JobSpec } from "@friday/sdk";
import type { Scheduler } from "../jobs/scheduler.js";
import { providerName } from "./catalogue.js";
import type { OAuthStore } from "./store.js";
import type { OAuthTokens } from "./tokens.js";

export function keepaliveJob(tokens: Pick<OAuthTokens, "refreshNow">, store: OAuthStore): JobSpec {
  return {
    name: "oauth-keepalive",
    description: "Refresh every connected OAuth login, so providers don't expire unused ones",
    // After the brain's 03:00 pass and retention at 04:00.
    cron: "0 5 * * *",
    timeoutMs: 5 * 60_000,
    async run({ signal, log }) {
      if (!store.secretsEnabled) return { summary: "nothing refreshed: FRIDAY_MASTER_KEY is not set" };
      let refreshed = 0;
      let skipped = 0;
      const reconnect: string[] = [];
      const retry: string[] = [];
      // One at a time: a household has a handful, and it keeps the providers' rate limits out of the picture.
      for (const conn of store.list().filter((c) => c.state === "connected")) {
        if (signal.aborted) break;
        const name = providerName(conn.provider);
        const outcome = await tokens.refreshNow(conn.provider);
        switch (outcome.result) {
          case "refreshed":
            refreshed++;
            break;
          case "skipped":
            skipped++;
            break;
          case "error":
            log.warn(`${conn.provider}: needs a reconnect: ${outcome.message}`);
            reconnect.push(`${name} (${outcome.message})`);
            break;
          case "retry":
            retry.push(`${name} (${outcome.message})`);
            break;
          case "changed":
            break;
        }
      }
      const parts = [`refreshed ${refreshed}`];
      if (skipped) parts.push(`skipped ${skipped}`);
      if (reconnect.length) parts.push(`needs reconnect: ${reconnect.join(", ")}`);
      if (retry.length) parts.push(`retry next run: ${retry.join(", ")}`);
      const summary = parts.join("; ");
      if (reconnect.length) throw new Error(summary);
      return { summary };
    },
  };
}

/** Registers the keep-alive as a `core` job; also without a master key, so the Jobs page shows why nothing happens. */
export function registerOAuthKeepalive(jobs: Scheduler, tokens: OAuthTokens, store: OAuthStore): void {
  jobs.register("core", keepaliveJob(tokens, store));
}
