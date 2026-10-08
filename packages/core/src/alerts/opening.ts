/**
 * The turn an alert session opens with: what went off, when, how late, and in which language to say it. It is an
 * instruction to the model, not something the user said, so it is never recorded.
 */
import type { Alert, AlertLanguage } from "./store.js";

const LANGUAGES: Record<AlertLanguage, string> = { nl: "Dutch", en: "English" };

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "5 minutes", "1 minute 30 seconds", "1 hour 5 minutes", "45 seconds". */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const parts = [h && plural(h, "hour"), m && plural(m, "minute"), s && plural(s, "second")].filter(Boolean) as string[];
  return parts.length ? parts.join(" ") : "0 seconds";
}

const clock = (at: Date, zone: string) => at.toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" });

function describe(a: Alert, now: Date, zone: string): string {
  const due = new Date(a.dueAt);
  // A snooze moves the due time: from then on it's "snoozed for N minutes", not a timer of the whole span.
  const from = new Date(a.snoozedAt ?? a.createdAt);
  const what = a.snoozedAt ? `snoozed for ${spokenDuration(due.getTime() - from.getTime())} at ${clock(from, zone)}` : `${spokenDuration(due.getTime() - from.getTime())}, set at ${clock(from, zone)}`;
  let s = `the ${a.kind} "${a.label}" (${what}) went off at ${clock(due, zone)}`;
  const lateMin = Math.floor((now.getTime() - due.getTime()) / 60_000);
  if (lateMin >= 1) s += `, ${plural(lateMin, "minute")} ago`;
  return s;
}

/** The opening text for the alerts announced in one session; the first alert's language is the one to speak. */
export function openingText(alerts: Alert[], now: Date, zone: string): string {
  if (!alerts.length) throw new Error("an alert session needs at least one alert");
  const what = alerts.map((a) => describe(a, now, zone)).join("; ");
  const lead = alerts.length === 1 ? "Alert" : "Alerts";
  return (
    `${lead}: ${what}. Tell the user briefly, in ${LANGUAGES[alerts[0].language]}, and wait for their answer. ` +
    "If they want more time, call snooze_alert."
  );
}
