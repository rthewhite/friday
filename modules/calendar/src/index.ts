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
import { DEFAULT_TIME_ZONE, defineModule } from "@friday/sdk";

export interface CalendarOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Clock for handles, tokens, the agenda and the change log (tests inject one). */
  now?: () => Date;
}

export function createCalendarModule(_opts: CalendarOptions = {}) {
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
    init() {},
  });
}

export default createCalendarModule();
