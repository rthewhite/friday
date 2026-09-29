/** Read access to recorded conversations (`ctx.conversations`). In-process modules only. */
import {
  compareMatches,
  foldSearchText,
  inWindow,
  searchableText,
  snippetsFor,
  validateSearch,
  type ConversationMatch,
  type SearchConversationsOptions,
} from "./conversation-search.js";

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
   * Conversations whose entries in `[since, until)` hold any of the query's words (any part of a word,
   * without case and accents), most distinct words first, then most recent activity; each with up to 3
   * snippets. Without words, the conversations with entries in the window, each with its first 3 of
   * them. Rejects with a `SearchQueryError` for an unknown channel, an invalid time or `since` after `until`.
   */
  search(opts?: SearchConversationsOptions): Promise<ConversationMatch[]>;
  /**
   * Best-effort, in-process notification each time a conversation goes quiet. Missed notifications
   * (restarts, reloads) are recovered with `list({ quietSince: <last quietAt seen> })`.
   * Returns an unsubscribe function; subscriptions also end when the module is disposed or reloaded.
   */
  onQuiet(handler: (e: QuietEvent) => void | Promise<void>): () => void;
}

/** An entry for `MemoryConversations.seed`; `seq` and `at` are filled in when omitted. */
export type SeedEntry = Loose<ConversationEntry>;
type Loose<E> = E extends ConversationEntry ? Omit<E, "seq" | "at"> & { seq?: number; at?: string } : never;

export interface SeedConversation extends Partial<Omit<ConversationSummary, "state" | "entryCount" | "preview">> {
  entries?: SeedEntry[];
}

type Logger = Pick<Console, "error">;

/** In-memory conversations for the test host: seed them, then mark them quiet to fire `onQuiet` handlers. */
export class MemoryConversations implements ModuleConversations {
  private readonly items = new Map<string, Conversation>();
  private readonly handlers = new Set<(e: QuietEvent) => void | Promise<void>>();
  private n = 0;

  constructor(private readonly log: Logger = { error() {} }) {}

  /** Store a conversation (quiet when `quietAt` is given). Returns what `get` will return. */
  seed(c: SeedConversation = {}): Conversation {
    const now = new Date().toISOString();
    const startedAt = c.startedAt ?? now;
    const entries = (c.entries ?? []).map((e, i) => ({ ...e, seq: e.seq ?? i + 1, at: e.at ?? startedAt }) as ConversationEntry);
    const firstUser = entries.find((e) => e.kind === "user");
    const conv: Conversation = {
      id: c.id ?? `conversation-${++this.n}`,
      channel: c.channel ?? "voice",
      device: c.device ?? null,
      startedAt,
      lastActivityAt: c.lastActivityAt ?? startedAt,
      endedAt: c.endedAt ?? null,
      endReason: c.endReason ?? null,
      quietAt: c.quietAt ?? null,
      state: c.quietAt ? "quiet" : "active",
      entryCount: entries.length,
      preview: firstUser?.kind === "user" ? firstUser.text.slice(0, 120) : null,
      entries,
    };
    this.items.set(conv.id, conv);
    return structuredClone(conv);
  }

  /** Mark a seeded conversation quiet now (or at `at`) and run every `onQuiet` handler; resolves once they settled. */
  async markQuiet(id: string, at = new Date().toISOString()): Promise<QuietEvent> {
    const c = this.items.get(id);
    if (!c) throw new Error(`no seeded conversation "${id}"`);
    c.quietAt = at;
    c.state = "quiet";
    const e: QuietEvent = { id, lastActivityAt: c.lastActivityAt, quietAt: at };
    for (const h of [...this.handlers]) {
      try {
        await h(e);
      } catch (err) {
        this.log.error(`onQuiet handler failed for ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    return e;
  }

  async list(opts: ListConversationsOptions = {}): Promise<ConversationSummary[]> {
    const limit = opts.limit ?? 50;
    const all = [...this.items.values()];
    const rows = opts.quietSince !== undefined
      ? all.filter((c) => c.quietAt && Date.parse(c.quietAt) > Date.parse(opts.quietSince!)).sort((a, b) => Date.parse(a.quietAt!) - Date.parse(b.quietAt!))
      : all.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    return rows.slice(0, limit).map(({ entries, ...summary }) => structuredClone(summary));
  }

  async get(id: string): Promise<Conversation | undefined> {
    const c = this.items.get(id);
    return c ? structuredClone(c) : undefined;
  }

  /** The store's search rules, with folded substring matching in place of the full-text index. */
  async search(opts: SearchConversationsOptions = {}): Promise<ConversationMatch[]> {
    const s = validateSearch(opts);
    const candidates: { c: Conversation; entries: ConversationEntry[]; matching?: Set<number>; words: number }[] = [];
    for (const c of this.items.values()) {
      if ((s.channel && c.channel !== s.channel) || (s.device !== undefined && c.device !== s.device) || s.exclude.includes(c.id)) continue;
      const entries = [...c.entries].sort((a, b) => a.seq - b.seq).filter((e) => inWindow(e.at, s));
      if (!entries.length) continue;
      if (!s.words.length) {
        candidates.push({ c, entries, words: 0 });
        continue;
      }
      const matching = new Set<number>();
      const found = new Set<string>();
      for (const e of entries) {
        const text = foldSearchText(searchableText(e));
        for (const w of s.words) {
          if (!text.includes(w)) continue;
          matching.add(e.seq);
          found.add(w);
        }
      }
      if (found.size) candidates.push({ c, entries, matching, words: found.size });
    }
    return candidates
      .sort((a, b) => compareMatches({ id: a.c.id, lastActivityAt: a.c.lastActivityAt, words: a.words }, { id: b.c.id, lastActivityAt: b.c.lastActivityAt, words: b.words }))
      .slice(0, s.limit)
      .map(({ c: { entries: _all, ...summary }, entries, matching }) => ({ ...structuredClone(summary), snippets: structuredClone(snippetsFor(entries, matching)) }));
  }

  onQuiet(handler: (e: QuietEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }

  /** Drop every subscription (the test host does this on dispose). */
  clearSubscriptions(): void {
    this.handlers.clear();
  }
}
