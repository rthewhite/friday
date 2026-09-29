/** Shapes of `/api/conversations`, shared by the Conversations and Chat pages. */
export interface Summary extends Record<string, unknown> {
  id: string;
  channel: "voice" | "chat";
  device: string | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: string | null;
  quietAt: string | null;
  state: "active" | "quiet";
  entryCount: number;
  preview: string | null;
}

export type Entry =
  | { seq: number; at: string; kind: "user"; input: "speech" | "text"; text: string }
  | { seq: number; at: string; kind: "assistant"; text: string; interrupted: boolean }
  | { seq: number; at: string; kind: "tool"; name: string; args: unknown; result?: unknown; truncated: boolean };

export interface Conversation extends Summary {
  entries: Entry[];
}
