/**
 * Control connections (`/ws/device`) per registered device: at most one each, for "online" and for telling a device
 * to ring. A newer connection replaces the older one (4409), so a device that reconnected before its old socket timed
 * out isn't counted twice.
 */

export interface LinkSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** What core sends a device over its control connection. */
export type LinkMessage = { type: "ring" | "stop"; data: { alert: string } };

export class DeviceLinks {
  private readonly open = new Map<string, LinkSocket>();
  private readonly listeners = new Set<(id: string) => void>();

  /** Track `ws` as the device's control connection, closing an older one with 4409. Online listeners are told. */
  add(id: string, ws: LinkSocket): void {
    const old = this.open.get(id);
    this.open.set(id, ws);
    if (old && old !== ws) old.close(4409, "replaced");
    for (const l of this.listeners) l(id);
  }

  /** Forget `ws` when it closes; a replaced socket closing later leaves the newer one in place. */
  remove(id: string, ws: LinkSocket): void {
    if (this.open.get(id) === ws) this.open.delete(id);
  }

  online(id: string): boolean {
    return this.open.has(id);
  }

  /** Send a message to the device; false when it has no control connection. */
  send(id: string, msg: LinkMessage): boolean {
    const ws = this.open.get(id);
    if (!ws) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /** Called with the device id whenever a device opens a control connection. Returns an unsubscribe function. */
  onOnline(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Close the device's control connection (revoked, deleted or key replaced). */
  disconnect(id: string): void {
    const ws = this.open.get(id);
    this.open.delete(id);
    ws?.close(4401, "unauthorized");
  }
}
