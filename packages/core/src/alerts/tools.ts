/**
 * The timer tools, owned by core because alerts live in core. All are voice-only: a timer rings the device it was
 * set on, and chat has no device (push notifications to a person are a later target).
 */
import { Type, type ToolRegistry } from "@friday/sdk";
import type { DeviceLinks } from "../devices/links.js";
import { AlertNotFound, type AlertService } from "./service.js";
import type { Alert, AlertLanguage } from "./store.js";

export const TOOL_OWNER = "core";
export const MAX_TIMER_SECONDS = 86_400;
export const MAX_LABEL = 60;
export const MAX_TIMERS_PER_DEVICE = 20;

export interface AlertToolsOptions {
  alerts: Pick<AlertService, "create" | "active" | "cancel" | "snooze">;
  links: Pick<DeviceLinks, "online">;
  /** Registered devices' labels by id, read once per tool call; an unknown device is named by its id. */
  deviceLabels: () => Map<string, string>;
  /** Household zone for the times the tools report (FRIDAY_TIMEZONE, resolved). */
  timezone: () => string;
  now?: () => number;
}

const LANGUAGES: readonly AlertLanguage[] = ["nl", "en"];

export function registerAlertTools(registry: ToolRegistry, opts: AlertToolsOptions): void {
  const now = opts.now ?? Date.now;
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: opts.timezone(), hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const timers = () => opts.alerts.active().filter((a) => a.kind === "timer");
  /** The model's view of the timers, with the device labels read once. */
  const described = (list: Alert[]) => {
    const labels = list.length ? opts.deviceLabels() : new Map<string, string>();
    return list.map((a) => describe(a, labels));
  };
  const describe = (a: Alert, labels: Map<string, string>) => ({
    id: a.id,
    label: a.label,
    device: labels.get(a.target.id) ?? a.target.id,
    due: time(a.dueAt),
    seconds_left: Math.max(0, Math.round((Date.parse(a.dueAt) - now()) / 1000)),
    state: a.state,
  });

  registry.add(TOOL_OWNER, {
    name: "set_timer",
    description:
      "Set a countdown timer on the device the user is talking to. Returns at once; when the timer is done Friday " +
      "rings this device and announces it. Give it a short label when the user names what it is for.",
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
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMER_SECONDS)
        return { error: `seconds must be a whole number from 1 to ${MAX_TIMER_SECONDS}` };
      const label = typeof args.label === "string" && args.label.trim() ? args.label.trim() : "timer";
      if (label.length > MAX_LABEL) return { error: `label must be at most ${MAX_LABEL} characters` };
      if (typeof language !== "string" || !LANGUAGES.includes(language as AlertLanguage)) return { error: "language must be nl or en" };
      if (!call.device) return { error: "Timers can only be set on a voice device for now, not here." };
      if (!opts.links.online(call.device))
        return { error: "This device can't ring yet: it has no control connection to Friday, so its firmware may need an update. No timer was set." };
      if (opts.alerts.active().filter((a) => a.kind === "timer" && a.state === "scheduled" && a.target.id === call.device).length >= MAX_TIMERS_PER_DEVICE)
        return { error: `This device already has ${MAX_TIMERS_PER_DEVICE} timers running; cancel one first.` };
      const a = opts.alerts.create({
        kind: "timer",
        label,
        language: language as AlertLanguage,
        dueAt: new Date(now() + seconds * 1000),
        target: { kind: "device", id: call.device },
        conversationId: call.conversationId,
      });
      return { id: a.id, label: a.label, due: time(a.dueAt), seconds };
    },
  });

  registry.add(TOOL_OWNER, {
    name: "list_timers",
    description: "List the timers that are running or ringing on every device, with the seconds left on each.",
    parameters: { type: Type.OBJECT, properties: {} },
    channels: ["voice"],
    handler: () => ({ timers: described(timers()) }),
  });

  registry.add(TOOL_OWNER, {
    name: "cancel_timer",
    description:
      "Cancel a running or ringing timer, by its id or its label. Without either, cancels the only timer there is. " +
      "When it can't tell which timer is meant, it cancels nothing and lists them so you can ask.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "The timer's id, from set_timer or list_timers" },
        label: { type: Type.STRING, description: "The timer's label" },
      },
    },
    channels: ["voice"],
    handler: (args: { id?: unknown; label?: unknown }) => {
      const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
      const label = typeof args.label === "string" ? args.label.trim().toLowerCase() : "";
      const all = timers();
      const matches = id ? all.filter((a) => a.id === id) : label ? all.filter((a) => a.label.toLowerCase() === label) : all;
      if (matches.length !== 1) {
        const why = !all.length ? "No timer is running." : matches.length ? "Several timers match; say which one." : "No timer matches.";
        return { error: `${why} Nothing was cancelled.`, timers: described(all) };
      }
      const cancelled = opts.alerts.cancel(matches[0].id);
      return { cancelled: { id: cancelled.id, label: cancelled.label } };
    },
  });

  registry.add(TOOL_OWNER, {
    name: "snooze_alert",
    description:
      "While a timer is ringing and the user wants more time, ring it again after this many minutes. " +
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
        return { snoozed: snoozed.map((a) => a.label), due: snoozed[0] ? time(snoozed[0].dueAt) : undefined };
      } catch (e) {
        if (e instanceof AlertNotFound) return { error: "Nothing is ringing here, so there is nothing to snooze." };
        throw e;
      }
    },
  });
}
