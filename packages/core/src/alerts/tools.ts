/**
 * The timer and alarm tools, owned by core because alerts live in core. All are voice-only: an alert rings the
 * device it was set on, and chat has no device (push notifications to a person are a later target).
 *
 * Every alert in a result carries `when`, the due time in words in the user's language and the household zone, so
 * the model confirms the time that was stored rather than the one it meant to store. The model never does clock
 * sums: an alarm takes the time of day as said, and core works out when that is.
 */
import { Type, type ToolCallContext, type ToolRegistry } from "@friday/sdk";
import { CORE_ID } from "../core-config.js";
import type { DeviceLinks } from "../devices/links.js";
import { alarmTime, localTime } from "./clock-time.js";
import { spokenDuration } from "./opening.js";
import { AlertNotFound, type AlertService } from "./service.js";
import type { Alert, AlertKind, AlertLanguage } from "./store.js";
import { spokenWhen } from "./when.js";

/** Core's own id: /api/modules lists the tools of this owner as the `core` entry. */
export const TOOL_OWNER = CORE_ID;
export const MAX_TIMER_SECONDS = 86_400;
export const MAX_LABEL = 60;
export const MAX_TIMERS_PER_DEVICE = 20;
export const MAX_ALARMS_PER_DEVICE = 20;

export interface AlertToolsOptions {
  alerts: Pick<AlertService, "create" | "active" | "cancel" | "snooze" | "reschedule">;
  links: Pick<DeviceLinks, "online">;
  /** Registered devices' labels by id, read once per tool call; an unknown device is named by its id. */
  deviceLabels: () => Map<string, string>;
  /** Household zone for the times the tools report (FRIDAY_TIMEZONE, resolved). */
  timezone: () => string;
  now?: () => number;
}

const LANGUAGES: readonly AlertLanguage[] = ["nl", "en"];
const KINDS: readonly AlertKind[] = ["timer", "alarm"];
const WHEN_RULE = "When you tell the user when an alert is due, say its `when` (or the seconds left), never the time you meant to set.";

export function registerAlertTools(registry: ToolRegistry, opts: AlertToolsOptions): void {
  const now = opts.now ?? Date.now;
  const zone = () => opts.timezone();
  const when = (a: Alert) => spokenWhen(new Date(a.dueAt), new Date(now()), zone(), a.language);
  const due = (a: Alert) => localTime(new Date(a.dueAt), zone());
  /** The model's view of the alerts, with the device labels read once. */
  const viewAll = (list: Alert[]) => {
    const labels = list.length ? opts.deviceLabels() : new Map<string, string>();
    return list.map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      device: labels.get(a.target.id) ?? a.target.id,
      due: due(a),
      when: when(a),
      seconds_left: Math.max(0, Math.round((Date.parse(a.dueAt) - now()) / 1000)),
      state: a.state,
    }));
  };
  const brief = (a: Alert) => ({ id: a.id, kind: a.kind, label: a.label, due: due(a), when: when(a) });

  /** Why the calling session can't have an alert of `kind`, if it can't. */
  const deviceError = (kind: AlertKind, call: ToolCallContext): string | undefined => {
    const what = kind === "alarm" ? "Alarms" : "Timers";
    if (!call.device) return `${what} can only be set on a voice device for now, not here.`;
    if (!opts.links.online(call.device))
      return `This device can't ring yet: it has no control connection to Friday, so its firmware may need an update. No ${kind} was set.`;
    return undefined;
  };
  const fullError = (kind: AlertKind, device: string): string | undefined => {
    const max = kind === "alarm" ? MAX_ALARMS_PER_DEVICE : MAX_TIMERS_PER_DEVICE;
    return scheduledOn(device, kind).length >= max ? `This device already has ${max} ${kind}s set; cancel one first.` : undefined;
  };
  const scheduledOn = (device: string, kind: AlertKind) => opts.alerts.active().filter((a) => a.kind === kind && a.state === "scheduled" && a.target.id === device);
  const parseLabel = (raw: unknown, fallback: string): { label: string } | { error: string } => {
    const label = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
    return label.length > MAX_LABEL ? { error: `label must be at most ${MAX_LABEL} characters` } : { label };
  };
  const validSeconds = (s: unknown): s is number => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= MAX_TIMER_SECONDS;
  const validLanguage = (l: unknown): l is AlertLanguage => typeof l === "string" && LANGUAGES.includes(l as AlertLanguage);

  /**
   * The one scheduled or ringing alert the arguments pick: by id, else every one that agrees with each of label,
   * due and kind given. Anything else is an error listing the alerts, so the model can ask which one.
   */
  const pick = (args: { id?: unknown; label?: unknown; due?: unknown; kind?: unknown }, verb: string): { alert: Alert } | { error: string; alerts?: unknown[] } => {
    const all = opts.alerts.active();
    const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
    const label = typeof args.label === "string" ? args.label.trim().toLowerCase() : "";
    let at = "";
    if (typeof args.due === "string" && args.due.trim()) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(args.due.trim());
      if (!m) return { error: 'due must be the alert\'s due time as HH:MM, e.g. "08:30"' };
      at = `${m[1].padStart(2, "0")}:${m[2]}`;
    }
    const kind = typeof args.kind === "string" ? args.kind : "";
    if (kind && !KINDS.includes(kind as AlertKind)) return { error: "kind must be timer or alarm" };
    const matches = id
      ? all.filter((a) => a.id === id)
      : all.filter((a) => (!label || a.label.toLowerCase() === label) && (!at || due(a) === at) && (!kind || a.kind === kind));
    if (matches.length === 1) return { alert: matches[0] };
    const why = !all.length ? "No timer or alarm is set." : matches.length ? "Several alerts match; say which one." : "No alert matches.";
    return { error: `${why} Nothing was ${verb}.`, alerts: viewAll(all) };
  };

  const selectors = {
    id: { type: Type.STRING, description: "The alert's id, from list_alerts or the tool that set it" },
    label: { type: Type.STRING, description: "The alert's label" },
    due: { type: Type.STRING, description: 'The alert\'s current due time as HH:MM, e.g. "08:30" for "the 8:30 alarm"' },
    kind: { type: Type.STRING, enum: [...KINDS], description: "timer or alarm" },
  };

  registry.add(TOOL_OWNER, {
    name: "set_timer",
    description:
      "Set a countdown timer for a length of time (\"ten minutes\", \"half an hour\") on the device the user is talking to. " +
      "A time of day (\"at 7:30\", \"tomorrow morning at eight\") is an alarm: use set_alarm, never work out seconds to reach a time. " +
      "Returns at once; when the timer is done Friday rings this device and announces it. Give it a short label when the user names what it is for. " +
      WHEN_RULE,
    parameters: {
      type: Type.OBJECT,
      properties: {
        seconds: { type: Type.INTEGER, description: `Length in seconds, 1 to ${MAX_TIMER_SECONDS}` },
        label: { type: Type.STRING, description: `What the timer is for, e.g. "eggs" (at most ${MAX_LABEL} characters)` },
        language: { type: Type.STRING, enum: [...LANGUAGES], description: "The language the user is speaking: nl or en" },
      },
      required: ["seconds", "language"],
    },
    channels: ["voice"],
    handler: (args: { seconds?: unknown; label?: unknown; language?: unknown }, call) => {
      const { seconds, language } = args;
      if (!validSeconds(seconds)) return { error: `seconds must be a whole number from 1 to ${MAX_TIMER_SECONDS}` };
      const label = parseLabel(args.label, "timer");
      if ("error" in label) return label;
      if (!validLanguage(language)) return { error: "language must be nl or en" };
      const refused = deviceError("timer", call) ?? fullError("timer", call.device!);
      if (refused) return { error: refused };
      const a = opts.alerts.create({
        kind: "timer",
        label: label.label,
        language,
        dueAt: new Date(now() + seconds * 1000),
        target: { kind: "device", id: call.device! },
        conversationId: call.conversationId,
      });
      return { ...brief(a), seconds };
    },
  });

  registry.add(TOOL_OWNER, {
    name: "set_alarm",
    description:
      "Set an alarm for a time of day on the device the user is talking to, e.g. \"wake me at 7:30\" or \"maak me morgen om half acht wakker\". " +
      "Pass the time as the user said it, as 24-hour HH:MM; Friday works out the day (the next time the clock shows it) and rings the device then " +
      "until the user answers. Only pass date for another day than the next one. Never work out seconds and never use set_timer for a time of day. " +
      "To correct or move an alarm already set, use change_alert, never set another one. The result lists the device's other alarms: if there is " +
      "one the user didn't mention, ask whether it should go. " +
      WHEN_RULE,
    parameters: {
      type: Type.OBJECT,
      properties: {
        time: { type: Type.STRING, description: 'The time of day, 24-hour HH:MM: "07:30" for half past seven in the morning, "19:30" in the evening' },
        date: { type: Type.STRING, description: "Only when the user names a day beyond the next time the clock shows `time`: YYYY-MM-DD, at most 7 days ahead" },
        label: { type: Type.STRING, description: `What the alarm is for, e.g. "wekker" (at most ${MAX_LABEL} characters)` },
        language: { type: Type.STRING, enum: [...LANGUAGES], description: "The language the user is speaking: nl or en" },
      },
      required: ["time", "language"],
    },
    channels: ["voice"],
    handler: (args: { time?: unknown; date?: unknown; label?: unknown; language?: unknown }, call) => {
      const at = alarmTime(args.time, args.date, new Date(now()), zone());
      if ("error" in at) return { error: `${at.error}. No alarm was set.` };
      const label = parseLabel(args.label, "alarm");
      if ("error" in label) return label;
      if (!validLanguage(args.language)) return { error: "language must be nl or en" };
      const refused = deviceError("alarm", call);
      if (refused) return { error: refused };
      const device = call.device!;
      const others = scheduledOn(device, "alarm");
      const existing = others.find((a) => Date.parse(a.dueAt) === at.at.getTime());
      if (existing)
        return { ...brief(existing), in: spokenDuration(at.at.getTime() - now()), already_set: true, others: others.filter((a) => a !== existing).map(brief) };
      const full = fullError("alarm", device);
      if (full) return { error: full };
      const a = opts.alerts.create({
        kind: "alarm",
        label: label.label,
        language: args.language,
        dueAt: at.at,
        target: { kind: "device", id: device },
        conversationId: call.conversationId,
      });
      return { ...brief(a), in: spokenDuration(at.at.getTime() - now()), others: others.map(brief) };
    },
  });

  registry.add(TOOL_OWNER, {
    name: "list_alerts",
    description:
      "List the timers and alarms that are set or ringing on every device, with when each is due and the seconds left. " +
      "Call it before telling the user which timers or alarms are set, including when they ask you to confirm one. " +
      WHEN_RULE,
    parameters: { type: Type.OBJECT, properties: {} },
    channels: ["voice"],
    handler: () => ({ alerts: viewAll(opts.alerts.active()) }),
  });

  registry.add(TOOL_OWNER, {
    name: "change_alert",
    description:
      "Move a timer or alarm that is set: an alarm to another time of day (time, and date only for another day), a timer to a new length " +
      "from now (seconds). Use this whenever the user corrects or changes one, never set a second one. Pick it by id, label, its current " +
      "due time or kind; without any, it changes the only one there is. When it can't tell which one is meant, it changes nothing and lists " +
      "them so you can ask. " +
      WHEN_RULE,
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...selectors,
        time: { type: Type.STRING, description: "For an alarm: the new time of day, 24-hour HH:MM" },
        date: { type: Type.STRING, description: "For an alarm on a later day than the next one: YYYY-MM-DD, at most 7 days ahead" },
        seconds: { type: Type.INTEGER, description: `For a timer: the new length in seconds from now, 1 to ${MAX_TIMER_SECONDS}` },
      },
    },
    channels: ["voice"],
    handler: (args: { id?: unknown; label?: unknown; due?: unknown; kind?: unknown; time?: unknown; date?: unknown; seconds?: unknown }) => {
      const picked = pick(args, "changed");
      if ("error" in picked) return picked;
      const a = picked.alert;
      if (a.state !== "scheduled") return { error: `The ${a.kind} "${a.label}" is ringing; snooze or cancel it instead. Nothing was changed.` };
      let dueAt: Date;
      if (a.kind === "alarm") {
        if (args.seconds !== undefined) return { error: "An alarm is moved with time (and date), not seconds. Nothing was changed." };
        const at = alarmTime(args.time, args.date, new Date(now()), zone());
        if ("error" in at) return { error: `${at.error}. Nothing was changed.` };
        dueAt = at.at;
      } else {
        if (args.time !== undefined || args.date !== undefined) return { error: "A timer is changed with seconds from now, not a time of day. Nothing was changed." };
        if (!validSeconds(args.seconds)) return { error: `seconds must be a whole number from 1 to ${MAX_TIMER_SECONDS}. Nothing was changed.` };
        dueAt = new Date(now() + args.seconds * 1000);
      }
      const was = when(a);
      const moved = opts.alerts.reschedule(a.id, dueAt);
      return { changed: { ...brief(moved), was } };
    },
  });

  registry.add(TOOL_OWNER, {
    name: "cancel_alert",
    description:
      "Cancel a timer or alarm that is set or ringing. Pick it by id, label, its due time (\"the 8:30 alarm\": due 08:30) or kind; " +
      "without any, it cancels the only one there is. When it can't tell which one is meant, it cancels nothing and lists them so you can ask. " +
      WHEN_RULE,
    parameters: { type: Type.OBJECT, properties: selectors },
    channels: ["voice"],
    handler: (args: { id?: unknown; label?: unknown; due?: unknown; kind?: unknown }) => {
      const picked = pick(args, "cancelled");
      if ("error" in picked) return picked;
      const a = picked.alert;
      const was = brief(a);
      opts.alerts.cancel(a.id);
      return { cancelled: was };
    },
  });

  registry.add(TOOL_OWNER, {
    name: "snooze_alert",
    description:
      "While a timer or alarm is ringing and the user wants more time, ring it again after this many minutes. " +
      "Only works in the conversation Friday started to announce it.",
    parameters: {
      type: Type.OBJECT,
      properties: { minutes: { type: Type.INTEGER, description: "Minutes until it rings again, 1 to 60 (default 5)" } },
    },
    channels: ["voice"],
    handler: (args: { minutes?: unknown }, call) => {
      const minutes = args.minutes ?? 5;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) return { error: "minutes must be a whole number from 1 to 60" };
      try {
        const snoozed = opts.alerts.snooze(call.device, minutes);
        return { snoozed: snoozed.map((a) => a.label), due: snoozed[0] ? due(snoozed[0]) : undefined, when: snoozed[0] ? when(snoozed[0]) : undefined };
      } catch (e) {
        if (e instanceof AlertNotFound) return { error: "Nothing is ringing here, so there is nothing to snooze." };
        throw e;
      }
    },
  });
}
