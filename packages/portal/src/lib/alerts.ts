/** Shapes of `/api/alerts` and how the Alerts page shows them. */
export type AlertState = "scheduled" | "ringing" | "acknowledged" | "cancelled" | "missed";
export type Tone = "neutral" | "success" | "warning" | "error" | "accent";

export interface AlertRecord extends Record<string, unknown> {
  id: string;
  kind: string;
  label: string;
  dueAt: string;
  target: { kind: string; id: string; label?: string };
  state: AlertState;
  createdAt: string;
  finishedAt: string | null;
  rings: number;
}

export const isActive = (a: Pick<AlertRecord, "state">): boolean => a.state === "scheduled" || a.state === "ringing";

/** The API lists active alerts first and finished ones newest first; the page shows them as two tables. */
export function splitAlerts(alerts: AlertRecord[]): { active: AlertRecord[]; finished: AlertRecord[] } {
  return { active: alerts.filter(isActive), finished: alerts.filter((a) => !isActive(a)) };
}

/** `4 min 30 s`, `45 s`, `1 h 5 min`; `ringing` once due. */
export function timeLeft(dueAt: string, now: number): string {
  const s = Math.ceil((Date.parse(dueAt) - now) / 1000);
  if (s <= 0) return "ringing";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return sec ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

/** Status dot tone per state: missed stands out. */
export const stateTone: Record<AlertState, Tone> = {
  scheduled: "neutral",
  ringing: "accent",
  acknowledged: "success",
  cancelled: "neutral",
  missed: "error",
};

/** The device an alert rings: its label, or its id once the device is gone. */
export const targetText = (a: Pick<AlertRecord, "target">): string => a.target.label ?? a.target.id;
