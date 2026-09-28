/** Read access to recorded conversations (`ctx.conversations`). In-process modules only. */

export type ConversationChannel = "voice" | "chat";
/** `speech` is Gemini's transcription of audio (noisy); `text` was typed (exact). */
export type ConversationInput = "speech" | "text";

export interface ConversationSummary {
  id: string;
  channel: ConversationChannel;
  device: string | null;
  startedAt: string;
  lastActivityAt: string;
  /** Set when the conversation ended explicitly (a voice session closed). */
  endedAt: string | null;
  endReason: string | null;
  /** When the conversation last went quiet; null while it is active. The watermark for `list({ quietSince })`. */
  quietAt: string | null;
  state: "active" | "quiet";
  entryCount: number;
  /** The first user entry, up to 120 characters. */
  preview: string | null;
}

export type ConversationEntry =
  | { seq: number; at: string; kind: "user"; input: ConversationInput; text: string }
  | { seq: number; at: string; kind: "assistant"; text: string; interrupted: boolean }
  /**
   * `args` and `result` are the JSON values, or the cut JSON text when larger than 4000 characters
   * (`truncated`). `result` is absent when the session closed before the tool settled.
   */
  | { seq: number; at: string; kind: "tool"; name: string; args: unknown; result?: unknown; truncated: boolean };

export interface Conversation extends ConversationSummary {
  entries: ConversationEntry[];
}

export interface QuietEvent {
  id: string;
  lastActivityAt: string;
  quietAt: string;
}

export interface ListConversationsOptions {
  /** Only conversations currently quiet that went quiet after this time, oldest first. */
  quietSince?: string;
  /** Default 50. */
  limit?: number;
}

export interface ModuleConversations {
  /** Without `quietSince`: most recently active first. With it: quiet since that time, oldest first. */
  list(opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation | undefined>;
  /**
   * Best-effort, in-process notification each time a conversation goes quiet. Missed notifications
   * (restarts, reloads) are recovered with `list({ quietSince: <last quietAt seen> })`.
   * Returns an unsubscribe function; subscriptions also end when the module is disposed or reloaded.
   */
  onQuiet(handler: (e: QuietEvent) => void | Promise<void>): () => void;
}
