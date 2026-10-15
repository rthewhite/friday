/**
 * An alert's due time as the words Friday should say, in the language the user set it in and the household zone:
 * "morgen, woensdag 14 oktober, om 07:30". Every alert tool returns it, so a confirmation can only name the time
 * that was stored.
 */
import { localDate } from "@friday/sdk";
import { addDays, localTime } from "./clock-time.js";
import type { AlertLanguage } from "./store.js";

const LOCALES: Record<AlertLanguage, string> = { nl: "nl-NL", en: "en-GB" };
const WORDS: Record<AlertLanguage, { today: string; tomorrow: string; at: string }> = {
  nl: { today: "vandaag", tomorrow: "morgen", at: "om" },
  en: { today: "today", tomorrow: "tomorrow", at: "at" },
};

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const dateFormat = (language: AlertLanguage, zone: string) => {
  const key = `${language} ${zone}`;
  let f = dateFormats.get(key);
  if (!f) {
    if (dateFormats.size >= 64) dateFormats.clear();
    f = new Intl.DateTimeFormat(LOCALES[language], { timeZone: zone, weekday: "long", day: "numeric", month: "long" });
    dateFormats.set(key, f);
  }
  return f;
};

/** "vandaag om 12:05", "tomorrow, Wednesday 14 October, at 07:30", "vrijdag 16 oktober om 07:30". */
export function spokenWhen(due: Date, now: Date, zone: string, language: AlertLanguage): string {
  const w = WORDS[language];
  const time = localTime(due, zone);
  const day = localDate(due, zone);
  const today = localDate(now, zone);
  if (day === today) return `${w.today} ${w.at} ${time}`;
  const date = dateFormat(language, zone).format(due);
  if (day === addDays(today, 1)) return `${w.tomorrow}, ${date}, ${w.at} ${time}`;
  return `${date} ${w.at} ${time}`;
}
