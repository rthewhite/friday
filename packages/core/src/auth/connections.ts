/**
 * Open browser voice connections by user and by the session they were opened with, so disabling the user or ending
 * that session (logout, a refused refresh) closes them with 4401; their Gemini sessions close with them. Device
 * connections are tracked by DeviceSessions instead.
 */
import type WebSocket from "ws";

export class UserConnections {
  private readonly byUser = new Map<string, Set<WebSocket>>();
  private readonly bySession = new Map<string, Set<WebSocket>>();

  /** Track `ws` for `userId` (and the session it was opened with, if any) until it closes. */
  add(userId: string, ws: WebSocket, sessionId?: string): void {
    track(this.byUser, userId, ws);
    if (sessionId) track(this.bySession, sessionId, ws);
  }

  /** Close every open connection of `userId` with 4401; returns how many there were. */
  closeUser(userId: string): number {
    return closeAll(this.byUser.get(userId));
  }

  /** Close every open connection opened with session `sessionId` with 4401; returns how many there were. */
  closeSession(sessionId: string): number {
    return closeAll(this.bySession.get(sessionId));
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

function track(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(ws);
  ws.once("close", () => {
    set.delete(ws);
    if (!set.size && map.get(key) === set) map.delete(key);
  });
}

function closeAll(set: Set<WebSocket> | undefined): number {
  if (!set) return 0;
  const n = set.size;
  for (const ws of [...set]) ws.close(4401, "unauthorized");
  return n;
}
