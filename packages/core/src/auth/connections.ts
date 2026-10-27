/**
 * Open browser voice connections by user, so disabling a user closes them with 4401 (their Gemini sessions close
 * with them). Device connections are tracked by DeviceSessions instead.
 */
import type WebSocket from "ws";

export class UserConnections {
  private readonly byUser = new Map<string, Set<WebSocket>>();

  /** Track `ws` for `userId` until it closes. */
  add(userId: string, ws: WebSocket): void {
    let set = this.byUser.get(userId);
    if (!set) this.byUser.set(userId, (set = new Set()));
    set.add(ws);
    ws.once("close", () => {
      set.delete(ws);
      if (!set.size && this.byUser.get(userId) === set) this.byUser.delete(userId);
    });
  }

  /** Close every open connection of `userId` with 4401; returns how many there were. */
  closeUser(userId: string): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    const n = set.size;
    for (const ws of [...set]) ws.close(4401, "unauthorized");
    return n;
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}
