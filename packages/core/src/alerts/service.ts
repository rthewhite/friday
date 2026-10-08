/**
 * Decides when alerts ring and what became of them. One timer, re-planned on every change, wakes the service at the
 * earliest moment something can happen: an alert's next ring, or its grace limit. A device is rung only while it is
 * online (control connection) and not in a conversation; going online or idle re-checks at once. One ring covers
 * every alert due on a device, and the alert session that answers it covers every alert ringing there.
 *
 * Ring outcomes: the user reacting in the alert session (or the button) acknowledges; snooze schedules again; an
 * unanswered ring (no session within ANSWER_TIMEOUT_MS, or a session that closed without either) rings again after
 * the ring interval, until the ring limit makes it missed. A device that rings an alert with its own tone reports
 * the outcome itself. No ring starts after an alert's grace limit; a ring in progress is never cut off.
 */
import { systemClock, type Clock } from "../jobs/scheduler.js";
import type { DeviceLinks } from "../devices/links.js";
import type { DeviceSessions } from "../devices/sessions.js";
import type { DeviceReport } from "../transports/device-ws.js";
import { openingText } from "./opening.js";
import type { Alert, AlertStore, FinalState, NewAlert } from "./store.js";

/** How long a device has to open an alert session after a ring. */
export const ANSWER_TIMEOUT_MS = 15_000;
/** The planning timer never sleeps longer than this, so clock changes and long timers stay harmless. */
const MAX_SLEEP_MS = 60 * 60 * 1000;

export class AlertNotFound extends Error {}
export class AlertConflict extends Error {}

/** An alert session's hold on the alerts it announces. */
export interface AlertClaim {
  alerts: Alert[];
  /** The opening turn for the session. */
  text: string;
  /** The user reacted: the alerts are acknowledged. */
  acknowledge(): void;
  /** The session closed (or never opened); without an acknowledge or snooze it counts as an unanswered ring. */
  closed(): void;
}

export interface AlertServiceOptions {
  store: AlertStore;
  links: Pick<DeviceLinks, "online" | "send" | "onOnline">;
  sessions: Pick<DeviceSessions, "connected" | "onIdle">;
  /** Household zone for the opening text (FRIDAY_TIMEZONE, resolved). */
  timezone: () => string;
  rings: number;
  ringIntervalMs: number;
  graceMs: number;
  clock?: Clock;
  log?: Pick<Console, "log" | "error">;
}

interface Ring {
  ids: string[];
  timer: unknown;
}

interface OpenClaim {
  ids: string[];
  outcome?: "acknowledged" | "snoozed";
}

export class AlertService {
  private readonly clock: Clock;
  private readonly log: Pick<Console, "log" | "error">;
  private timer: unknown;
  private stopped = true;
  /** Rings sent and waiting for the device to open its alert session, per device. */
  private readonly ringing = new Map<string, Ring>();
  /** Open alert sessions, per device. */
  private readonly claims = new Map<string, OpenClaim>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly opts: AlertServiceOptions) {
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? console;
  }

  /** Resume after a (re)start: devices re-report their local rings, and alerts that were ringing ring again now. */
  start(): void {
    this.stopped = false;
    const now = this.now();
    this.opts.store.resetLocal();
    for (const a of this.opts.store.active()) {
      if (a.state === "ringing" && new Date(a.nextRingAt) > now) this.opts.store.update(a.id, { nextRingAt: now });
    }
    this.unsubscribe.push(this.opts.links.onOnline(() => this.tick()), this.opts.sessions.onIdle(() => this.tick()));
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubscribe.splice(0)) u();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const r of this.ringing.values()) this.clock.clearTimeout(r.timer);
    this.ringing.clear();
    this.claims.clear();
  }

  create(a: NewAlert): Alert {
    const created = this.opts.store.create(a);
    this.log.log(`alerts: ${created.kind} ${created.id} "${created.label}" for ${created.target.id}, due ${created.dueAt}`);
    this.tick();
    return created;
  }

  get(id: string): Alert | undefined {
    return this.opts.store.get(id);
  }

  list(): Alert[] {
    return this.opts.store.list();
  }

  active(): Alert[] {
    return this.opts.store.active();
  }

  /** Cancel a scheduled or ringing alert; a device ringing it is told to stop. */
  cancel(id: string): Alert {
    const a = this.opts.store.get(id);
    if (!a) throw new AlertNotFound(`no alert ${id}`);
    if (a.state !== "scheduled" && a.state !== "ringing") throw new AlertConflict(`alert ${id} is already ${a.state}`);
    const out = this.finish(a, "cancelled");
    this.tick();
    return out;
  }

  /** The device was deleted: its alerts are cancelled and forgotten. */
  cancelDevice(deviceId: string): Alert[] {
    const r = this.ringing.get(deviceId);
    if (r) this.clock.clearTimeout(r.timer);
    this.ringing.delete(deviceId);
    this.claims.delete(deviceId);
    const cancelled = this.opts.store.cancelTarget({ kind: "device", id: deviceId });
    this.tick();
    return cancelled;
  }

  /**
   * Snooze the alerts of the device's open alert session: due again `minutes` from now, back to scheduled, rings
   * reset. Throws AlertNotFound when the device has no alert session.
   */
  snooze(deviceId: string | undefined, minutes: number): Alert[] {
    const claim = deviceId === undefined ? undefined : this.claims.get(deviceId);
    if (!claim) throw new AlertNotFound("nothing is ringing");
    const due = new Date(this.now().getTime() + minutes * 60_000);
    const out: Alert[] = [];
    for (const id of claim.ids) {
      const a = this.opts.store.get(id);
      // Answering acknowledged them a moment ago; only alerts cancelled or missed meanwhile stay as they are.
      if (!a || (a.state !== "ringing" && a.state !== "acknowledged")) continue;
      out.push(this.opts.store.update(id, { state: "scheduled", dueAt: due, nextRingAt: due, rings: 0, local: false })!);
    }
    claim.outcome = "snoozed";
    this.log.log(`alerts: ${deviceId} snoozed ${out.map((a) => a.id).join(", ")} until ${due.toISOString()}`);
    this.tick();
    return out;
  }

  /**
   * An alert session for `alertId` on `deviceId` is opening. Returns its claim on every alert ringing on the device,
   * or undefined when that alert isn't ringing there (anymore) or the device already has an alert session.
   */
  claim(deviceId: string, alertId: string): AlertClaim | undefined {
    const a = this.opts.store.get(alertId);
    if (!a || a.state !== "ringing" || a.target.kind !== "device" || a.target.id !== deviceId || this.claims.has(deviceId)) return undefined;
    const r = this.ringing.get(deviceId);
    if (r) this.clock.clearTimeout(r.timer);
    this.ringing.delete(deviceId);
    const alerts = this.opts.store.active({ kind: "device", id: deviceId }).filter((x) => x.state === "ringing" && !x.local);
    const open: OpenClaim = { ids: alerts.map((x) => x.id) };
    this.claims.set(deviceId, open);
    this.log.log(`alerts: ${deviceId} answered the ring for ${open.ids.join(", ")}`);
    let done = false;
    return {
      alerts,
      text: openingText(alerts, this.now(), this.opts.timezone()),
      acknowledge: () => {
        if (open.outcome || this.claims.get(deviceId) !== open) return;
        open.outcome = "acknowledged";
        for (const id of open.ids) {
          const x = this.opts.store.get(id);
          if (x?.state === "ringing") this.finish(x, "acknowledged");
        }
      },
      closed: () => {
        if (done) return;
        done = true;
        if (this.claims.get(deviceId) !== open) return;
        this.claims.delete(deviceId);
        if (!open.outcome) this.unanswered(open.ids);
        this.tick();
      },
    };
  }

  /** What a device reports over its control connection about an alert it was asked to ring. */
  deviceReport(deviceId: string, type: DeviceReport, alertId: string): void {
    const a = this.opts.store.get(alertId);
    if (!a || a.state !== "ringing" || a.target.kind !== "device" || a.target.id !== deviceId) return;
    if (type === "ringing_locally") {
      this.opts.store.update(a.id, { local: true });
      const r = this.ringing.get(deviceId);
      if (r?.ids.includes(a.id)) {
        this.clock.clearTimeout(r.timer);
        this.ringing.delete(deviceId);
      }
      this.log.log(`alerts: ${deviceId} rings ${a.id} with its own tone`);
    } else if (type === "acknowledged") {
      const claim = this.claims.get(deviceId);
      if (claim?.ids.includes(a.id)) claim.outcome ??= "acknowledged";
      this.finish(a, "acknowledged");
    } else if (type === "unanswered") {
      if (!a.local) return;
      this.finish(a, "missed");
    }
    this.tick();
  }

  /** Ring what is due, miss what is past its grace limit, and plan the next wake-up. */
  private tick(): void {
    if (this.stopped) return;
    const now = this.now(), t = now.getTime();
    const due = new Map<string, Alert[]>();
    for (const a of this.opts.store.active()) {
      if (a.local || this.inProgress(a)) continue;
      const deadline = new Date(a.dueAt).getTime() + this.opts.graceMs;
      const free = this.free(a.target.id);
      if (free && new Date(a.nextRingAt).getTime() <= t && t <= deadline) {
        const list = due.get(a.target.id) ?? [];
        list.push(a);
        due.set(a.target.id, list);
      } else if (t >= deadline) {
        this.log.log(`alerts: ${a.id} "${a.label}" missed (${free ? "unanswered" : "device offline or busy"} until its grace limit)`);
        this.finish(a, "missed");
      }
    }
    for (const [deviceId, alerts] of due) this.ring(deviceId, alerts);
    this.plan();
  }

  private ring(deviceId: string, alerts: Alert[]): void {
    for (const a of alerts) if (a.state !== "ringing") this.opts.store.update(a.id, { state: "ringing" });
    const ids = alerts.map((a) => a.id);
    if (!this.opts.links.send(deviceId, { type: "ring", data: { alert: ids[0] } })) return;
    this.log.log(`alerts: ringing ${deviceId} for ${ids.join(", ")}`);
    const timer = this.clock.setTimeout(() => {
      if (this.ringing.get(deviceId)?.timer !== timer) return;
      this.ringing.delete(deviceId);
      this.log.log(`alerts: ${deviceId} did not answer the ring`);
      this.unanswered(ids);
      this.tick();
    }, ANSWER_TIMEOUT_MS);
    this.ringing.set(deviceId, { ids, timer });
  }

  /** One more unanswered ring for each alert still ringing: ring again later, or missed at the ring limit. */
  private unanswered(ids: string[]): void {
    const next = new Date(this.now().getTime() + this.opts.ringIntervalMs);
    for (const id of ids) {
      const a = this.opts.store.get(id);
      if (!a || a.state !== "ringing" || a.local) continue;
      const rings = a.rings + 1;
      if (rings >= this.opts.rings) {
        this.log.log(`alerts: ${a.id} "${a.label}" missed after ${rings} unanswered rings`);
        this.opts.store.update(id, { rings });
        this.finish(this.opts.store.get(id)!, "missed");
      } else this.opts.store.update(id, { rings, nextRingAt: next });
    }
  }

  /** Put an alert in a final state; a device that may be ringing it is told to stop. */
  private finish(a: Alert, state: FinalState): Alert {
    const out = this.opts.store.update(a.id, { state })!;
    if (a.state === "ringing" && a.target.kind === "device") this.opts.links.send(a.target.id, { type: "stop", data: { alert: a.id } });
    return out;
  }

  /** Wake at the earliest next ring of a device that can be rung, or grace limit. */
  private plan(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    let next = Infinity;
    for (const a of this.opts.store.active()) {
      if (a.local || this.inProgress(a)) continue;
      const deadline = new Date(a.dueAt).getTime() + this.opts.graceMs;
      next = Math.min(next, deadline, this.free(a.target.id) ? new Date(a.nextRingAt).getTime() : Infinity);
    }
    if (next === Infinity) return;
    const delay = Math.min(Math.max(0, next - this.clock.now()), MAX_SLEEP_MS);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, delay);
  }

  /** A ring was sent for it, or an alert session announces it. */
  private inProgress(a: Alert): boolean {
    const id = a.target.id;
    return (this.ringing.get(id)?.ids.includes(a.id) ?? false) || (this.claims.get(id)?.ids.includes(a.id) ?? false);
  }

  /** The device can be rung now: online, not in a conversation, no ring or alert session in progress. */
  private free(deviceId: string): boolean {
    return this.opts.links.online(deviceId) && !this.opts.sessions.connected(deviceId) && !this.ringing.has(deviceId) && !this.claims.has(deviceId);
  }

  private now(): Date {
    return new Date(this.clock.now());
  }
}
