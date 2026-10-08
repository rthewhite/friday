/** Shapes of `/api/devices`, shared by the Voice devices and Conversations pages. */
export interface DeviceRecord extends Record<string, unknown> {
  id: string;
  label: string;
  area: string | null;
  notes: string | null;
  fingerprint: string;
  createdAt: string;
  keyReplacedAt: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
  /** Its control connection is open: Friday can reach it, e.g. to ring a timer. */
  online: boolean;
  /** It has a conversation open. */
  connected: boolean;
  replacement?: { fingerprint: string; lastSeenAt: string; attempts: number };
}

export interface PendingRecord extends Record<string, unknown> {
  id: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
}

export interface DevicesListing {
  devices: DeviceRecord[];
  pending: PendingRecord[];
}

export type DeviceState = "revoked" | "in a session" | "online" | "offline";

/** A device's status dot: revoked, in a session, online (reachable), or offline (Friday can't ring it). */
export function deviceStatus(d: Pick<DeviceRecord, "revoked" | "online" | "connected">): { state: DeviceState; tone: "error" | "accent" | "success" | "neutral" } {
  if (d.revoked) return { state: "revoked", tone: "error" };
  if (d.connected) return { state: "in a session", tone: "accent" };
  if (d.online) return { state: "online", tone: "success" };
  return { state: "offline", tone: "neutral" };
}

/** Registered device ids to their labels. */
export const deviceLabels = (devices: Pick<DeviceRecord, "id" | "label">[]): Map<string, string> => new Map(devices.map((d) => [d.id, d.label]));

/** How a conversation's device is shown: a registered device by its label with the id on hover, others by id. */
export function deviceDisplay(labels: Map<string, string>, id: string | null): { text: string; title?: string } | null {
  if (!id) return null;
  const label = labels.get(id);
  return label ? { text: label, title: id } : { text: id };
}
