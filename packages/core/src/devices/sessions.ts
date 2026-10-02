/** Open `/ws/audio` connections per registered device: the listing's "connected", and closing them on revoke. */

export interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

export class DeviceSessions {
  private readonly open = new Map<string, Set<ClosableSocket>>();

  add(id: string, ws: ClosableSocket): void {
    let set = this.open.get(id);
    if (!set) this.open.set(id, (set = new Set()));
    set.add(ws);
  }

  remove(id: string, ws: ClosableSocket): void {
    const set = this.open.get(id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.open.delete(id);
  }

  connected(id: string): boolean {
    return this.open.has(id);
  }

  /** Close every open connection of the device; their close handlers end the Gemini sessions. */
  disconnect(id: string): void {
    for (const ws of [...(this.open.get(id) ?? [])]) ws.close(4401, "unauthorized");
    this.open.delete(id);
  }
}
