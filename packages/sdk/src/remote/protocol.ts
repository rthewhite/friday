import type { ModuleManifest } from "../module.js";

export const REMOTE_PROTOCOL = 1;
export const SCHEDULING_META = "friday/scheduling";

export interface HelloMessage {
  type: "hello";
  key: string;
  manifest: ModuleManifest;
  protocol: number;
}

export interface WelcomeMessage {
  type: "welcome";
  id: string;
}

/** WebSocket close codes used on /ws/modules. */
export const CloseCode = {
  /** Server is shutting down; reconnect later. */
  GOING_AWAY: 1001,
  /** Malformed hello or unsupported protocol; do not retry. */
  BAD_REQUEST: 4400,
  /** Unknown key or key does not belong to the manifest id; do not retry. */
  UNAUTHORIZED: 4401,
  /** No hello within the deadline. */
  HELLO_TIMEOUT: 4408,
  /** A newer connection for the same id replaced this one. */
  REPLACED: 4409,
} as const;

export const NO_RETRY_CODES: readonly number[] = [CloseCode.BAD_REQUEST, CloseCode.UNAUTHORIZED];
