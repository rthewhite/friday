/**
 * The user's iCloud calendar over CalDAV. Friday reads events, creates them straight away, and edits or
 * deletes them only through a preview and `calendar_confirm`; every change is logged and can be undone.
 * Today's and tomorrow's agenda goes into the prompt from a cache the `calendar/refresh` job keeps fresh.
 *
 * Config (declared in the manifest, read per request through ctx.config):
 *   ICLOUD_USERNAME      the Apple ID email
 *   ICLOUD_APP_PASSWORD  an app-specific password (account.apple.com > Sign-In and Security)
 *   FRIDAY_TIMEZONE      household zone for times without an offset and for every time returned
 */
import { DEFAULT_TIME_ZONE, defineModule, householdTimeZone } from "@friday/sdk";
import { Agenda, REFRESH_EVERY_MS } from "./agenda.js";
import { CalDavClient } from "./caldav.js";
import { ChangeLog } from "./changes.js";
import { registerCalendarRoutes } from "./routes.js";
import { migrations } from "./schema.js";
import { EventHandles } from "./handles.js";
import { CalendarService } from "./service.js";
import { Settings } from "./settings.js";
import { TokenStore } from "./tokens.js";
import { defineCalendarTools } from "./tools.js";

export interface CalendarOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Clock for handles, tokens, the agenda and the change log (tests inject one). */
  now?: () => Date;
}

export function createCalendarModule(opts: CalendarOptions = {}) {
  const now = opts.now ?? (() => new Date());
  return defineModule({
    manifest: {
      id: "calendar",
      label: "Calendar",
      description: "The user's iCloud calendar: what's on, and adding, moving or removing events with confirmation and undo.",
      ui: true,
      config: [
        { key: "ICLOUD_USERNAME", required: true, description: "Apple ID email of the iCloud account" },
        { key: "ICLOUD_APP_PASSWORD", required: true, secret: true, description: "App-specific password for that Apple ID (account.apple.com > Sign-In and Security > App-Specific Passwords)" },
        { key: "FRIDAY_TIMEZONE", description: `IANA zone for event times (default ${DEFAULT_TIME_ZONE})` },
      ],
    },
    migrations,
    async init(ctx) {
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
      const service = new CalendarService({ client, settings, handles: new EventHandles(now), tokens: new TokenStore(now), changes, zone, now, onWrite: refresh });
      const agenda = new Agenda(service, settings, now);
      defineCalendarTools(ctx, service);
      ctx.jobs.schedule({
        name: "refresh",
        description: "Rediscovers the iCloud calendars and fetches today's and tomorrow's agenda for the prompt.",
        everyMs: REFRESH_EVERY_MS,
        timeoutMs: 60_000,
        run: async ({ signal }) => {
          again = false;
          try {
            const r = await agenda.refresh(signal);
            return { summary: `${r.events} event${r.events === 1 ? "" : "s"} in ${r.calendars} calendar${r.calendars === 1 ? "" : "s"}` };
          } finally {
            // After the scheduler has marked this run finished.
            if (again) setTimeout(refresh, 0).unref();
          }
        },
      });
      ctx.prompt.addContext(() => agenda.render());
      registerCalendarRoutes(ctx, { service, settings, agenda, changes });
      // No iCloud request during init: a down iCloud must not fail the module. The first refresh runs right away.
      refresh();
    },
  });
}

export default createCalendarModule();
