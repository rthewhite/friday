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

/** Registered device ids to their labels. */
export const deviceLabels = (devices: Pick<DeviceRecord, "id" | "label">[]): Map<string, string> => new Map(devices.map((d) => [d.id, d.label]));

/** How a conversation's device is shown: a registered device by its label with the id on hover, others by id. */
export function deviceDisplay(labels: Map<string, string>, id: string | null): { text: string; title?: string } | null {
  if (!id) return null;
  const label = labels.get(id);
  return label ? { text: label, title: id } : { text: id };
}
