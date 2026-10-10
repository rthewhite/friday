/**
 * The user's calendars from two optional sources: an iCloud account over CalDAV, and a read-only Work calendar
 * (Outlook) that a Power Automate flow drops at the homelab intake. Friday reads events, creates them straight
 * away in iCloud, and edits or deletes them only through a preview and `calendar_confirm`; every change is logged
 * and can be undone. Today's and tomorrow's agenda goes into the prompt from what the `calendar/refresh` job keeps
 * fresh.
 *
 * Config (declared in the manifest, read per request through ctx.config; at least one source must be complete):
 *   ICLOUD_USERNAME      the Apple ID email
 *   ICLOUD_APP_PASSWORD  an app-specific password (account.apple.com > Sign-In and Security)
 *   INTAKE_URL           the intake's /out endpoint
 *   INTAKE_KEY           its bearer key. Reading the intake removes what it returns: configure it in one place only
 *   FRIDAY_TIMEZONE      household zone for times without an offset and for every time returned
 */
import { DEFAULT_TIME_ZONE, defineModule, householdTimeZone } from "@friday/sdk";
import { Agenda, REFRESH_EVERY_MS } from "./agenda.js";
import { CalDavClient } from "./caldav.js";
import { ChangeLog } from "./changes.js";
import { IntakeClient } from "./intake.js";
import { registerCalendarRoutes } from "./routes.js";
import { migrations } from "./schema.js";
import { EventHandles } from "./handles.js";
import { CalendarService } from "./service.js";
import { Settings } from "./settings.js";
import { TokenStore } from "./tokens.js";
import { defineCalendarTools } from "./tools.js";
import { INTAKE_KEYS, WorkSource } from "./work.js";

export const ICLOUD_KEYS = ["ICLOUD_USERNAME", "ICLOUD_APP_PASSWORD"] as const;

export interface CalendarOptions {
  /** Injectable for tests: iCloud requests. */
  fetch?: typeof fetch;
  /** Injectable for tests: intake requests. */
  intakeFetch?: typeof fetch;
  /** Clock for handles, tokens, the agenda and the change log (tests inject one). */
  now?: () => Date;
}

export function createCalendarModule(opts: CalendarOptions = {}) {
  const now = opts.now ?? (() => new Date());
  return defineModule({
    manifest: {
      id: "calendar",
      label: "Calendar",
      description: "The user's calendars: iCloud (what's on, and adding, moving or removing events with confirmation and undo) and a read-only Work calendar from Outlook.",
      ui: true,
      config: [
        { key: "ICLOUD_USERNAME", description: "Apple ID email of the iCloud account" },
        { key: "ICLOUD_APP_PASSWORD", secret: true, description: "App-specific password for that Apple ID (account.apple.com > Sign-In and Security > App-Specific Passwords)" },
        { key: "INTAKE_URL", description: "The intake's /out endpoint for the Work calendar (set it in one place only: reading removes what it returns)" },
        { key: "INTAKE_KEY", secret: true, description: "Bearer key for the intake" },
        { key: "FRIDAY_TIMEZONE", description: `IANA zone for event times (default ${DEFAULT_TIME_ZONE})` },
      ],
    },
    migrations,
    async init(ctx) {
      const icloudMissing = () => ICLOUD_KEYS.filter((k) => !ctx.config.get(k)?.trim());
      const work = new WorkSource({
        storage: ctx.storage,
        client: new IntakeClient({ fetch: opts.intakeFetch, config: () => ({ url: ctx.config.require("INTAKE_URL").trim(), key: ctx.config.require("INTAKE_KEY").trim() }) }),
        config: ctx.config,
        now,
        log: ctx.log,
      });
      if (icloudMissing().length && work.missing().length) {
        const unset = [...icloudMissing(), ...work.missing()].join(", ");
        throw new Error(`calendar: configure ${ICLOUD_KEYS.join(" and ")}, or ${INTAKE_KEYS.join(" and ")} (not set: ${unset})`);
      }
      await work.load();
      const client = new CalDavClient({
        fetch: opts.fetch,
        credentials: () => ({ username: ctx.config.require("ICLOUD_USERNAME").trim(), password: ctx.config.require("ICLOUD_APP_PASSWORD").trim() }),
        log: ctx.log,
      });
      const settings = new Settings(ctx.storage);
      await settings.load();
      const zone = householdTimeZone(ctx.config, (m) => ctx.log.warn(m));
      const changes = new ChangeLog(ctx.db, now);
      // A write during a running refresh may not be in what that run fetched: run once more after it.
      let again = false;
      const refresh = () => {
        try {
          if (!ctx.jobs.trigger("refresh").started) again = true;
        } catch {
          // The module was disposed or reloaded; its job is gone.
        }
      };
      const service = new CalendarService({ client, settings, handles: new EventHandles(now), tokens: new TokenStore(now), changes, zone, now, onWrite: refresh, log: ctx.log, work, icloudMissing });
      const agenda = new Agenda(service, settings, now);
      defineCalendarTools(ctx, service);
      ctx.jobs.schedule({
        name: "refresh",
        description: "Takes a new Work calendar copy from the intake, rediscovers the iCloud calendars and fetches today's and tomorrow's agenda for the prompt.",
        everyMs: REFRESH_EVERY_MS,
        timeoutMs: 60_000,
        run: async ({ signal }) => {
          again = false;
          try {
            return await agenda.refresh(signal);
          } finally {
            // After the scheduler has marked this run finished.
            if (again) setTimeout(refresh, 0).unref();
          }
        },
      });
      ctx.prompt.addContext(() => agenda.render());
      registerCalendarRoutes(ctx, { service, settings, agenda, changes, work });
      // No iCloud request during init: a down iCloud must not fail the module. The first refresh runs right away.
      refresh();
    },
  });
}

export default createCalendarModule();
