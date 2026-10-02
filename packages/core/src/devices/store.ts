/**
 * Voice devices, onboarded by trust on first use: a device presents a key it generated itself, an unknown id (or a
 * known id with a different key) is recorded as a pending attempt, and the user accepts it in the portal. Keys are
 * stored as SHA-256 hashes only; the fingerprint shown to the user is derived from the hash.
 */
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashKey } from "../remote/key-store.js";

export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DEVICE_KEY = /^[A-Za-z0-9_-]{32,128}$/;
export const LIMITS = { label: 80, area: 80, notes: 1000 } as const;
/** Pending attempts are dropped this long after their last attempt, and at most this many are kept. */
export const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 20;

/** First 8 hex characters of the key's SHA-256, as `xxxx-xxxx`. The firmware computes the same. */
export const fingerprint = (keyHash: string): string => `${keyHash.slice(0, 4)}-${keyHash.slice(4, 8)}`;

/** What a voice session gets of its device; read once when the connection is accepted. */
export interface DeviceSnapshot {
  id: string;
  label: string;
  area: string | null;
  notes: string | null;
}

export interface Device extends DeviceSnapshot {
  fingerprint: string;
  createdAt: string;
  keyReplacedAt: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
  /** A different key this id presented, waiting to replace the stored one. */
  replacement?: { fingerprint: string; lastSeenAt: string; attempts: number };
}

export interface PendingDevice {
  id: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
}

export type AuthResult =
  | { ok: true; device: DeviceSnapshot }
  | { ok: false; code: 4400 | 4401 | 4403; reason: "bad device" | "unauthorized" | "pending approval" };

export interface DeviceInput {
  label?: unknown;
  area?: unknown;
  notes?: unknown;
}

export class DeviceInputError extends Error {}
export class DeviceNotFound extends Error {}
export class DeviceConflict extends Error {}

interface DeviceRow {
  id: string;
  label: string;
  area: string | null;
  notes: string | null;
  key_hash: string;
  created_at: string;
  key_replaced_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface AttemptRow {
  device_id: string;
  key_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  attempts: number;
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** A trimmed optional text field: undefined leaves it unchanged, empty clears it. */
function optionalText(value: unknown, field: "area" | "notes"): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new DeviceInputError(`${field} must be a string`);
  const v = value.trim();
  if (v.length > LIMITS[field]) throw new DeviceInputError(`${field} must be at most ${LIMITS[field]} characters`);
  return v || null;
}

function labelText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new DeviceInputError("label must be a string");
  const v = value.trim();
  if (!v) throw new DeviceInputError("label must not be empty");
  if (v.length > LIMITS.label) throw new DeviceInputError(`label must be at most ${LIMITS.label} characters`);
  return v;
}

function fingerprintInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new DeviceInputError("fingerprint is required");
  return value.trim().toLowerCase();
}

export class DeviceStore {
  private readonly now: () => Date;

  constructor(private readonly db: DatabaseSync, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Decide on a connection to `/ws/audio?device=<id>`; records an attempt when the device awaits approval. */
  authenticate(id: string, key: string | undefined): AuthResult {
    if (!DEVICE_ID.test(id)) return { ok: false, code: 4400, reason: "bad device" };
    if (key === undefined || key === "") return { ok: false, code: 4401, reason: "unauthorized" };
    if (!DEVICE_KEY.test(key)) return { ok: false, code: 4400, reason: "bad device" };
    const row = this.row(id);
    if (row?.revoked_at) return { ok: false, code: 4401, reason: "unauthorized" };
    const hash = hashKey(key);
    if (row && sameHash(row.key_hash, hash)) {
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.iso(), id);
      return { ok: true, device: snapshot(row) };
    }
    this.recordAttempt(id, hash);
    return { ok: false, code: 4403, reason: "pending approval" };
  }

  list(): { devices: Device[]; pending: PendingDevice[] } {
    this.prune();
    const attempts = new Map((this.db.prepare("SELECT * FROM device_attempts ORDER BY last_seen_at DESC").all() as unknown as AttemptRow[]).map((a) => [a.device_id, a]));
    const devices = (this.db.prepare("SELECT * FROM devices ORDER BY created_at, id").all() as unknown as DeviceRow[]).map((r) => {
      const d = toDevice(r);
      const a = attempts.get(r.id);
      attempts.delete(r.id);
      if (a && !r.revoked_at) d.replacement = { fingerprint: fingerprint(a.key_hash), lastSeenAt: a.last_seen_at, attempts: a.attempts };
      return d;
    });
    const pending = [...attempts.values()].map((a) => ({ id: a.device_id, fingerprint: fingerprint(a.key_hash), firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at, attempts: a.attempts }));
    return { devices, pending };
  }

  get(id: string): Device | undefined {
    return this.list().devices.find((d) => d.id === id);
  }

  /** Register a pending id with the key the user saw (by fingerprint). */
  accept(id: string, body: DeviceInput & { fingerprint?: unknown }): Device {
    const seen = fingerprintInput(body.fingerprint);
    const label = labelText(typeof body.label === "string" && !body.label.trim() ? undefined : body.label) ?? id;
    const area = optionalText(body.area, "area") ?? null;
    const notes = optionalText(body.notes, "notes") ?? null;
    return this.transaction(() => {
      const attempt = this.attempt(id);
      if (!attempt) throw new DeviceNotFound(`no pending device ${id}`);
      if (this.row(id)) throw new DeviceConflict(`device ${id} is already registered`);
      if (fingerprint(attempt.key_hash) !== seen) throw new DeviceConflict(`device ${id} now presents a different key (${fingerprint(attempt.key_hash)})`);
      this.db.prepare("INSERT INTO devices (id, label, area, notes, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, label, area, notes, attempt.key_hash, this.iso());
      this.db.prepare("DELETE FROM device_attempts WHERE device_id = ?").run(id);
      return toDevice(this.row(id)!);
    });
  }

  /** Forget a pending attempt; the next attempt records it again. */
  ignore(id: string): void {
    if (this.db.prepare("DELETE FROM device_attempts WHERE device_id = ?").run(id).changes === 0) throw new DeviceNotFound(`no pending device ${id}`);
  }

  update(id: string, body: DeviceInput): Device {
    const label = labelText(body.label);
    const area = optionalText(body.area, "area");
    const notes = optionalText(body.notes, "notes");
    const row = this.row(id);
    if (!row) throw new DeviceNotFound(`no device ${id}`);
    this.db.prepare("UPDATE devices SET label = ?, area = ?, notes = ? WHERE id = ?").run(label ?? row.label, area === undefined ? row.area : area, notes === undefined ? row.notes : notes, id);
    return this.get(id)!;
  }

  /** Swap the stored key for the pending replacement the user saw (by fingerprint). */
  replaceKey(id: string, body: { fingerprint?: unknown }): Device {
    const seen = fingerprintInput(body.fingerprint);
    this.transaction(() => {
      const row = this.row(id);
      if (!row) throw new DeviceNotFound(`no device ${id}`);
      const attempt = this.attempt(id);
      if (!attempt || row.revoked_at) throw new DeviceNotFound(`no pending key for device ${id}`);
      if (fingerprint(attempt.key_hash) !== seen) throw new DeviceConflict(`device ${id} now presents a different key (${fingerprint(attempt.key_hash)})`);
      this.db.prepare("UPDATE devices SET key_hash = ?, key_replaced_at = ? WHERE id = ?").run(attempt.key_hash, this.iso(), id);
      this.db.prepare("DELETE FROM device_attempts WHERE device_id = ?").run(id);
    });
    return this.get(id)!;
  }

  revoke(id: string): Device {
    const row = this.row(id);
    if (!row) throw new DeviceNotFound(`no device ${id}`);
    this.transaction(() => {
      if (!row.revoked_at) this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(this.iso(), id);
      this.db.prepare("DELETE FROM device_attempts WHERE device_id = ?").run(id);
    });
    return this.get(id)!;
  }

  remove(id: string): void {
    this.transaction(() => {
      if (this.db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes === 0) throw new DeviceNotFound(`no device ${id}`);
      this.db.prepare("DELETE FROM device_attempts WHERE device_id = ?").run(id);
    });
  }

  private recordAttempt(id: string, hash: string): void {
    const at = this.iso();
    this.db
      .prepare(
        `INSERT INTO device_attempts (device_id, key_hash, first_seen_at, last_seen_at, attempts) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (device_id) DO UPDATE SET key_hash = excluded.key_hash, last_seen_at = excluded.last_seen_at, attempts = attempts + 1`,
      )
      .run(id, hash, at, at);
    this.prune();
  }

  /** Drop attempts older than the TTL, then all but the most recent MAX_ATTEMPTS. */
  private prune(): void {
    const cutoff = new Date(this.now().getTime() - ATTEMPT_TTL_MS).toISOString();
    this.db.prepare("DELETE FROM device_attempts WHERE last_seen_at < ?").run(cutoff);
    this.db
      .prepare("DELETE FROM device_attempts WHERE device_id NOT IN (SELECT device_id FROM device_attempts ORDER BY last_seen_at DESC, device_id LIMIT ?)")
      .run(MAX_ATTEMPTS);
  }

  private row(id: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  }

  private attempt(id: string): AttemptRow | undefined {
    this.prune();
    return this.db.prepare("SELECT * FROM device_attempts WHERE device_id = ?").get(id) as AttemptRow | undefined;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

const snapshot = (r: DeviceRow): DeviceSnapshot => ({ id: r.id, label: r.label, area: r.area, notes: r.notes });

const toDevice = (r: DeviceRow): Device => ({
  ...snapshot(r),
  fingerprint: fingerprint(r.key_hash),
  createdAt: r.created_at,
  keyReplacedAt: r.key_replaced_at,
  lastSeenAt: r.last_seen_at,
  revoked: r.revoked_at !== null,
});
