/**
 * The nightly `core/oauth-keepalive` job: refreshes every connected login, used or not, so providers that drop idle
 * refresh tokens (Google, Microsoft) don't, and a login revoked at the provider shows up as `error` within a day.
 */
import type { JobSpec } from "@friday/sdk";
import type { Scheduler } from "../jobs/scheduler.js";
import { providerName } from "./catalogue.js";
import type { OAuthStore } from "./store.js";
import type { OAuthTokens, RefreshOutcome } from "./tokens.js";

/** How long one provider gets before the run moves on, so a hanging token endpoint can't starve the ones after it. */
export const REFRESH_LIMIT_MS = 30_000;

export interface KeepaliveOptions {
  refreshLimitMs?: number;
}

export function keepaliveJob(tokens: Pick<OAuthTokens, "refreshNow">, store: OAuthStore, o: KeepaliveOptions = {}): JobSpec {
  const limitMs = o.refreshLimitMs ?? REFRESH_LIMIT_MS;
  return {
    name: "oauth-keepalive",
    description: "Refresh every connected OAuth login, so providers don't expire unused ones",
    // After the brain's 03:00 pass and retention at 04:00.
    cron: "0 5 * * *",
    timeoutMs: 5 * 60_000,
    async run({ signal, log }) {
      if (!store.secretsEnabled) return { summary: "nothing refreshed: FRIDAY_MASTER_KEY is not set" };
      const connections = store.list();
      let refreshed = 0;
      const skipped: string[] = [];
      const reconnect: string[] = [];
      const retry: string[] = [];
      // One at a time: a household has a handful, and it keeps the providers' rate limits out of the picture.
      for (const conn of connections.filter((c) => c.state === "connected")) {
        if (signal.aborted) break;
        const name = providerName(conn.provider);
        const outcome = await within(tokens.refreshNow(conn.provider), limitMs);
        switch (outcome.result) {
          case "refreshed":
            refreshed++;
            break;
          case "skipped":
            skipped.push(`${name} (${outcome.reason})`);
            break;
          case "error":
            log.warn(`${conn.provider}: needs a reconnect: ${outcome.message}`);
            reconnect.push(`${name} (${outcome.message})`);
            break;
          case "retry":
            log.warn(`${conn.provider}: refresh failed, retrying next run: ${outcome.message}`);
            retry.push(`${name} (${outcome.message})`);
            break;
          case "changed":
            log.log(`${conn.provider}: changed during the refresh, its outcome was discarded`);
            break;
        }
      }
      // Logins that broke on an earlier night: not this run's failure, but still worth a line until reconnected.
      const stillBroken = connections.filter((c) => c.state === "error").map((c) => providerName(c.provider));
      const parts = [`refreshed ${refreshed}`];
      if (skipped.length) parts.push(`skipped: ${skipped.join(", ")}`);
      if (reconnect.length) parts.push(`needs reconnect: ${reconnect.join(", ")}`);
      if (retry.length) parts.push(`retry next run: ${retry.join(", ")}`);
      if (stillBroken.length) parts.push(`still needs reconnect: ${stillBroken.join(", ")}`);
      const summary = parts.join("; ");
      if (reconnect.length) throw new Error(summary);
      return { summary };
    },
  };
}

/** The refresh's outcome, or `retry` when it takes longer than the limit (the refresh itself carries on). */
function within(refresh: Promise<RefreshOutcome>, ms: number): Promise<RefreshOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<RefreshOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ result: "retry", message: `no answer within ${Math.round(ms / 1000)} s` }), ms);
  });
  return Promise.race([refresh, late]).finally(() => clearTimeout(timer));
}

/** Registers the keep-alive as a `core` job; also without a master key, so the Jobs page shows why nothing happens. */
export function registerOAuthKeepalive(jobs: Scheduler, tokens: OAuthTokens, store: OAuthStore): void {
  jobs.register("core", keepaliveJob(tokens, store));
}
