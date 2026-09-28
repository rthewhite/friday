import type { Clock } from "../src/jobs/scheduler.js";

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Deterministic time for the scheduler: timers fire in due order at their exact time while `advance` walks the clock forward. */
export class FakeClock implements Clock {
  private seq = 0;
  timers = new Map<number, { at: number; fn: () => void; seq: number }>();
  constructor(public t: number) {}
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, seq: id });
    return id;
  };
  clearTimeout = (id: unknown) => void this.timers.delete(id as number);
  /** A promise that resolves after `ms` of fake time; handlers use it to "take" time. */
  sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const id = this.setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { this.clearTimeout(id); reject(signal.reason); });
    });
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
    await flush();
  }
  /** Advance to an absolute time. */
  to = (iso: string) => this.advance(Date.parse(iso) - this.t);
}
