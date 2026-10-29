/**
 * Conversation store over friday.db: transcript text and tool activity, never audio.
 * Conversations are resumable threads; they go quiet on an explicit end or after
 * `quietMinutes` without activity (the sweep), and every time they do, `onQuiet`
 * subscribers hear about it. The durable contract is `list({ quietSince })`.
 *
 * Every conversation belongs to one user, and whatever reads conversations for a person (the API, chat, modules) goes
 * through `forUser(id)`: another user's conversation is never listed, found or returned there. The unscoped methods
 * are for core's own bookkeeping (recorders, retention, a chat turn that already checked its thread).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Conversation,
  ConversationChannel,
  ConversationEntry,
  ConversationInput,
  ConversationMatch,
  ConversationSummary,
  ListConversationsOptions,
  ModuleConversations,
  QuietEvent,
  SearchConversationsOptions,
  UserConversations,
  ValidSearch,
} from "@friday/sdk";
import { CHANNELS, compareMatches, SearchQueryError, snippetsFor, validateSearch } from "@friday/sdk";
import { ConversationRecorder, type RecorderLog } from "./recorder.js";

/** Tool arguments and results are cut at this many characters of JSON. */
export const MAX_TOOL_JSON = 4000;
export const PREVIEW_LENGTH = 120;
export const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export type NewEntry =
  | { kind: "user"; at: string; input: ConversationInput; text: string }
  | { kind: "assistant"; at: string; text: string; interrupted?: boolean }
  /** `result` undefined means the tool never settled (the session closed first). */
  | { kind: "tool"; at: string; name: string; args: unknown; result?: unknown };

export interface ConversationMeta {
  channel: ConversationChannel;
  device?: string | null;
  /**
   * The user the conversation belongs to: the chat or Talk page user, the owner for a device, the agent's creator for
   * a run. Kept on resume. Null only for a device's session while no owner is recorded.
   */
  userId?: string | null;
}

/** Who a conversation belongs to, with their current name; null when nobody (a device's session before an owner existed). */
export type ConversationUser = { id: string; name: string } | null;

export interface ListOptions extends ListConversationsOptions {
  /** Opaque cursor from `cursorOf` (the last row of the previous page); recent-first listing only. */
  before?: string;
  /** Only conversations of this channel. */
  channel?: ConversationChannel;
  /** Only this user's conversations (set by `forUser`). */
  userId?: string;
}

/** One user's conversations, as the API and chat read them. */
export interface UserConversationView {
  list(opts?: Omit<ListOptions, "userId">): ConversationSummary[];
  /** Undefined for an unknown id and for another user's conversation alike. */
  get(id: string): Conversation | undefined;
  search(opts?: SearchConversationsOptions): ConversationMatch[];
  /** `missing` for an unknown id and for another user's conversation alike. */
  delete(id: string): "deleted" | "missing" | "live";
  /** Whether `id` is one of this user's conversations. */
  owns(id: string): boolean;
}

export interface ConversationStoreOptions {
  now?: () => Date;
  /** Minutes without activity before an active conversation goes quiet. Default 30. */
  quietMinutes?: number;
  /** Sweep interval. Default 60 s. */
  sweepMs?: number;
  log?: Pick<Console, "log" | "error">;
}

type QuietHandler = (e: QuietEvent) => void | Promise<void>;

interface Row {
  id: string;
  channel: ConversationChannel;
  device: string | null;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  end_reason: string | null;
  quiet_at: string | null;
  entry_count: number;
  preview: string | null;
}

interface EntryRow {
  seq: number;
  kind: "user" | "assistant" | "tool";
  input: ConversationInput | null;
  text: string | null;
  interrupted: number;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  truncated: number;
  at: string;
}

const COLUMNS = "id, channel, device, started_at, last_activity_at, ended_at, end_reason, quiet_at, entry_count, preview";

/** Encode the paging cursor for a row; clients pass it back as `before` without parsing it. */
export const cursorOf = (c: Pick<ConversationSummary, "lastActivityAt" | "id">): string => Buffer.from(`${c.lastActivityAt}|${c.id}`).toString("base64url");

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || !id) throw new InvalidQuery("invalid cursor");
  return { at, id };
}

/** Bad `before`, `quietSince` or search input; the API answers 400. A `SearchQueryError`, as modules expect from `search`. */
export class InvalidQuery extends SearchQueryError {}

function toIso(v: string, what: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new InvalidQuery(`invalid ${what}`);
  return d.toISOString();
}

/** JSON text capped at MAX_TOOL_JSON characters. */
function capJson(v: unknown): { text: string | null; truncated: boolean } {
  if (v === undefined) return { text: null, truncated: false };
  const text = JSON.stringify(v) ?? null;
  if (text !== null && text.length > MAX_TOOL_JSON) return { text: text.slice(0, MAX_TOOL_JSON), truncated: true };
  return { text, truncated: false };
}

/** The stored value, or the cut text when truncation left invalid JSON. */
function readJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summary(r: Row): ConversationSummary {
  return {
    id: r.id,
    channel: r.channel,
    device: r.device,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    quietAt: r.quiet_at,
    state: r.quiet_at ? "quiet" : "active",
    entryCount: r.entry_count,
    preview: r.preview,
  };
}

function entry(r: EntryRow): ConversationEntry {
  if (r.kind === "user") return { seq: r.seq, at: r.at, kind: "user", input: r.input ?? "speech", text: r.text ?? "" };
  if (r.kind === "assistant") return { seq: r.seq, at: r.at, kind: "assistant", text: r.text ?? "", interrupted: r.interrupted === 1 };
  const e: ConversationEntry = { seq: r.seq, at: r.at, kind: "tool", name: r.tool_name ?? "", args: readJson(r.tool_args) ?? null, truncated: r.truncated === 1 };
  const result = readJson(r.tool_result);
  if (result !== undefined) e.result = result;
  return e;
}

export class ConversationStore {
  readonly now: () => Date;
  private readonly quietMs: number;
  private readonly sweepMs: number;
  private readonly log: Pick<Console, "log" | "error">;
  /** Conversation id -> number of live recorders writing into it. */
  private readonly live = new Map<string, number>();
  private readonly subscribers = new Set<{ handler: QuietHandler; owner?: string }>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseSync, opts: ConversationStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.quietMs = (opts.quietMinutes ?? 30) * 60_000;
    this.sweepMs = opts.sweepMs ?? 60_000;
    this.log = opts.log ?? console;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** A new, active conversation with no entries. Recorders call this on their first entry, passing its time. */
  create(meta: ConversationMeta, startedAt = this.iso()): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO conversations (id, channel, device, user_id, started_at, last_activity_at, entry_count) VALUES (?, ?, ?, ?, ?, ?, 0)")
      .run(id, meta.channel, meta.device || null, meta.userId || null, startedAt, this.iso());
    return id;
  }

  /**
   * Write one entry at `seq` (recorders reserve positions, so writes may arrive out of order).
   * Moves last activity forward, keeps the count and preview, and makes a quiet conversation active again.
   */
  append(id: string, seq: number, e: NewEntry): void {
    const args = e.kind === "tool" ? capJson(e.args ?? null) : { text: null, truncated: false };
    const result = e.kind === "tool" ? capJson(e.result) : { text: null, truncated: false };
    const text = e.kind === "tool" ? null : e.text;
    this.tx(() => {
      this.db
        .prepare("INSERT INTO conversation_entries (conversation_id, seq, kind, input, text, interrupted, tool_name, tool_args, tool_result, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, seq, e.kind, e.kind === "user" ? e.input : null, text, e.kind === "assistant" && e.interrupted ? 1 : 0, e.kind === "tool" ? e.name : null, args.text, result.text, args.truncated || result.truncated ? 1 : 0, e.at);
      const preview = e.kind === "user" ? e.text.slice(0, PREVIEW_LENGTH) : null;
      this.db
        .prepare(`UPDATE conversations SET last_activity_at = MAX(last_activity_at, ?), entry_count = entry_count + 1,
                  preview = COALESCE(preview, ?), quiet_at = NULL, ended_at = NULL, end_reason = NULL WHERE id = ?`)
        .run(this.iso(), preview, id);
    });
  }

  /** The seq after the highest stored one, or undefined for an unknown conversation. Used to resume a thread. */
  nextSeq(id: string): number | undefined {
    const row = this.db.prepare("SELECT (SELECT COALESCE(MAX(seq), 0) FROM conversation_entries WHERE conversation_id = c.id) AS max FROM conversations c WHERE c.id = ?").get(id) as { max: number } | undefined;
    return row ? row.max + 1 : undefined;
  }

  /**
   * Mark an active conversation quiet now; `ended` also records the end time and reason.
   * Subscribers are notified after the write. Returns false when it was already quiet or unknown.
   */
  markQuiet(id: string, end?: { reason?: string | null }): boolean {
    const at = this.iso();
    const changed = end
      ? this.db.prepare("UPDATE conversations SET quiet_at = ?, ended_at = ?, end_reason = ? WHERE id = ? AND quiet_at IS NULL").run(at, at, end.reason || null, id).changes
      : this.db.prepare("UPDATE conversations SET quiet_at = ? WHERE id = ? AND quiet_at IS NULL").run(at, id).changes;
    if (!changed) return false;
    const row = this.db.prepare("SELECT last_activity_at, user_id FROM conversations WHERE id = ?").get(id) as { last_activity_at: string; user_id: string | null };
    this.notify({ id, userId: row.user_id, lastActivityAt: row.last_activity_at, quietAt: at });
    return true;
  }

  /** The channel of a stored conversation, or undefined when it is unknown. Does not read entries. */
  channelOf(id: string): ConversationChannel | undefined {
    return (this.db.prepare("SELECT channel FROM conversations WHERE id = ?").get(id) as { channel: ConversationChannel } | undefined)?.channel;
  }

  /** The user of each conversation in `ids`, with their current name. */
  usersOf(ids: readonly string[]): Map<string, ConversationUser> {
    const out = new Map<string, ConversationUser>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(`SELECT c.id, u.id AS user_id, u.name FROM conversations c LEFT JOIN users u ON u.id = c.user_id WHERE c.id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as { id: string; user_id: string | null; name: string | null }[];
    for (const r of rows) out.set(r.id, r.user_id && r.name !== null ? { id: r.user_id, name: r.name } : null);
    return out;
  }

  /** The user a conversation belongs to: undefined when unknown, null when nobody. */
  ownerOf(id: string): string | null | undefined {
    const row = this.db.prepare("SELECT user_id FROM conversations WHERE id = ?").get(id) as { user_id: string | null } | undefined;
    return row && row.user_id;
  }

  /** Unscoped: core's own reads. People read through `forUser`. */
  get(id: string): Conversation | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM conversations WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const entries = this.db.prepare("SELECT seq, kind, input, text, interrupted, tool_name, tool_args, tool_result, truncated, at FROM conversation_entries WHERE conversation_id = ? ORDER BY seq").all(id) as unknown as EntryRow[];
    return { ...summary(row), entries: entries.map(entry) };
  }

  /** Recent activity first (paged with `before`), or with `quietSince` the quiet ones after that time, oldest first. */
  list(opts: ListOptions = {}): ConversationSummary[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    if (opts.channel !== undefined && !CHANNELS.includes(opts.channel)) throw new InvalidQuery(`invalid channel: ${String(opts.channel)}`);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.channel) {
      where.push("channel = ?");
      params.push(opts.channel);
    }
    if (opts.userId !== undefined) {
      where.push("user_id = ?");
      params.push(opts.userId);
    }
    let order = "last_activity_at DESC, id DESC";
    if (opts.quietSince !== undefined) {
      where.push("quiet_at IS NOT NULL AND quiet_at > ?");
      params.push(toIso(opts.quietSince, "quietSince"));
      order = "quiet_at ASC, id ASC";
    } else if (opts.before) {
      const c = decodeCursor(opts.before);
      where.push("(last_activity_at < ? OR (last_activity_at = ? AND id < ?))");
      params.push(c.at, c.at, c.id);
    }
    const sql = `SELECT ${COLUMNS} FROM conversations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as unknown as Row[]).map(summary);
  }

  /**
   * Conversations whose entries in the window hold any of the query's words, through the full-text index
   * (one MATCH per word, so each conversation's distinct words can be counted); ranking and snippets follow
   * the SDK's shared rules. Without words, the conversations with entries in the window, most recent first.
   */
  search(opts: SearchConversationsOptions & { userId?: string } = {}): ConversationMatch[] {
    let s: ValidSearch;
    try {
      s = validateSearch(opts);
    } catch (e) {
      throw e instanceof SearchQueryError ? new InvalidQuery(e.message) : e;
    }
    const window: string[] = [];
    const windowParams: string[] = [];
    if (s.since) {
      window.push("e.at >= ?");
      windowParams.push(s.since);
    }
    if (s.until) {
      window.push("e.at < ?");
      windowParams.push(s.until);
    }
    const scope: string[] = [];
    const scopeParams: string[] = [];
    if (s.channel) {
      scope.push("c.channel = ?");
      scopeParams.push(s.channel);
    }
    if (s.device !== undefined) {
      scope.push("c.device = ?");
      scopeParams.push(s.device);
    }
    if (opts.userId !== undefined) {
      scope.push("c.user_id = ?");
      scopeParams.push(opts.userId);
    }
    if (s.exclude.length) {
      scope.push(`c.id NOT IN (${s.exclude.map(() => "?").join(", ")})`);
      scopeParams.push(...s.exclude);
    }

    const found = new Map<string, { lastActivityAt: string; seqs: Set<number>; words: Set<string> }>();
    if (!s.words.length) {
      const sql = `SELECT c.id, c.last_activity_at FROM conversations c
                   WHERE EXISTS (SELECT 1 FROM conversation_entries e WHERE e.conversation_id = c.id${window.map((w) => ` AND ${w}`).join("")})
                   ${scope.map((w) => ` AND ${w}`).join("")}
                   ORDER BY c.last_activity_at DESC, c.id DESC LIMIT ?`;
      for (const r of this.db.prepare(sql).all(...windowParams, ...scopeParams, s.limit) as { id: string; last_activity_at: string }[]) {
        found.set(r.id, { lastActivityAt: r.last_activity_at, seqs: new Set(), words: new Set() });
      }
    } else {
      // One row per conversation and word, with the matching entries' seqs, so a common word costs one row per
      // conversation rather than one per entry.
      const sql = `SELECT e.conversation_id AS id, c.last_activity_at, group_concat(e.seq) AS seqs FROM conversation_search s
                   JOIN conversation_entries e ON e.id = s.rowid JOIN conversations c ON c.id = e.conversation_id
                   WHERE conversation_search MATCH ?${[...window, ...scope].map((w) => ` AND ${w}`).join("")}
                   GROUP BY e.conversation_id`;
      const stmt = this.db.prepare(sql);
      for (const word of s.words) {
        // A quoted FTS5 string, so the user's words are never read as query syntax.
        const phrase = `"${word.replaceAll('"', '""')}"`;
        for (const r of stmt.all(phrase, ...windowParams, ...scopeParams) as { id: string; last_activity_at: string; seqs: string }[]) {
          const hit = found.get(r.id) ?? { lastActivityAt: r.last_activity_at, seqs: new Set<number>(), words: new Set<string>() };
          for (const seq of r.seqs.split(",")) hit.seqs.add(Number(seq));
          hit.words.add(word);
          found.set(r.id, hit);
        }
      }
    }

    const ranked = [...found]
      .map(([id, hit]) => ({ id, lastActivityAt: hit.lastActivityAt, words: hit.words.size, seqs: hit.seqs }))
      .sort(compareMatches)
      .slice(0, s.limit);
    const conversation = this.db.prepare(`SELECT ${COLUMNS} FROM conversations WHERE id = ?`);
    // Snippets never carry a tool's result, so it is not read.
    const entries = this.db.prepare(
      `SELECT seq, kind, input, text, interrupted, tool_name, tool_args, NULL AS tool_result, truncated, at FROM conversation_entries e
       WHERE e.conversation_id = ?${window.map((w) => ` AND ${w}`).join("")} ORDER BY seq`,
    );
    return ranked.map((r) => {
      const row = conversation.get(r.id) as unknown as Row;
      const inWindow = (entries.all(r.id, ...windowParams) as unknown as EntryRow[]).map(entry);
      return { ...summary(row), snippets: snippetsFor(inWindow, s.words.length ? r.seqs : undefined) };
    });
  }

  /** Unscoped. `live` while a recorder still writes into it; entries go with the conversation (cascade). */
  delete(id: string): "deleted" | "missing" | "live" {
    if (this.isLive(id)) return "live";
    return this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes ? "deleted" : "missing";
  }

  /**
   * Delete up to `batch` conversations whose last activity is before `cutoff`, in one transaction,
   * skipping live ones. Returns how many were deleted; call again until it returns 0.
   */
  prune(cutoff: Date, batch = 500): number {
    const ids = (this.db.prepare("SELECT id FROM conversations WHERE last_activity_at < ? ORDER BY last_activity_at LIMIT ?").all(cutoff.toISOString(), batch + this.live.size) as { id: string }[])
      .map((r) => r.id)
      .filter((id) => !this.isLive(id))
      .slice(0, batch);
    if (!ids.length) return 0;
    const del = this.db.prepare("DELETE FROM conversations WHERE id = ?");
    this.tx(() => { for (const id of ids) del.run(id); });
    return ids.length;
  }

  /** Mark quiet every active conversation idle for the quiet period, except those with a live recorder. */
  sweep(): number {
    const cutoff = new Date(this.now().getTime() - this.quietMs).toISOString();
    const ids = (this.db.prepare("SELECT id FROM conversations WHERE quiet_at IS NULL AND last_activity_at < ?").all(cutoff) as { id: string }[]).map((r) => r.id);
    let n = 0;
    for (const id of ids) if (!this.isLive(id) && this.markQuiet(id)) n++;
    return n;
  }

  /** Sweep now (catching conversations orphaned by a restart) and then every `sweepMs`. */
  start(): void {
    if (this.timer) return;
    const run = () => {
      try {
        this.sweep();
      } catch (e) {
        this.log.error("conversations: quiet sweep failed", e instanceof Error ? e.message : e);
      }
    };
    run();
    this.timer = setInterval(run, this.sweepMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Subscribe to quiet notifications; `owner` (a module id) tags log lines and `removeOwner`. */
  onQuiet(handler: QuietHandler, owner?: string): () => void {
    const sub = { handler, owner };
    this.subscribers.add(sub);
    return () => void this.subscribers.delete(sub);
  }

  removeOwner(owner: string): void {
    for (const s of this.subscribers) if (s.owner === owner) this.subscribers.delete(s);
  }

  /** Handlers run after the write committed, each isolated: a throwing one is logged and the others still run. */
  private notify(e: QuietEvent): void {
    const subs = [...this.subscribers];
    if (!subs.length) return;
    setImmediate(() => {
      for (const s of subs) {
        const fail = (err: unknown) => this.log.error(`conversations: onQuiet handler${s.owner ? ` of ${s.owner}` : ""} failed for ${e.id}:`, err instanceof Error ? err.message : err);
        try {
          void Promise.resolve(s.handler(e)).catch(fail);
        } catch (err) {
          fail(err);
        }
      }
    });
  }

  /** One user's conversations: the only way the API, chat and modules read them. */
  forUser(userId: string): UserConversationView {
    const owns = (id: string) => this.ownerOf(id) === userId;
    return {
      list: (o = {}) => this.list({ ...o, userId }),
      get: (id) => (owns(id) ? this.get(id) : undefined),
      search: (o = {}) => this.search({ ...o, userId }),
      delete: (id) => (owns(id) ? this.delete(id) : "missing"),
      owns,
    };
  }

  /** Read access for one module (`ctx.conversations`): one user's conversations at a time. */
  forOwner(owner: string): ModuleConversations {
    return {
      forUser: (userId): UserConversations => {
        const view = this.forUser(userId);
        return {
          list: async (o) => view.list({ quietSince: o?.quietSince, limit: o?.limit }),
          get: async (id) => view.get(id),
          search: async (o) => view.search(o),
        };
      },
      onQuiet: (handler) => this.onQuiet(handler, owner),
    };
  }

  isLive(id: string): boolean {
    return (this.live.get(id) ?? 0) > 0;
  }

  /** Recorders hold the conversations they write into, so the sweep and DELETE leave them alone. */
  attach(id: string): void {
    this.live.set(id, (this.live.get(id) ?? 0) + 1);
  }

  detach(id: string): void {
    const n = (this.live.get(id) ?? 0) - 1;
    if (n > 0) this.live.set(id, n);
    else this.live.delete(id);
  }

  /** A recorder for one new conversation; nothing is stored until its first entry. */
  recorder(meta: ConversationMeta, log?: RecorderLog): ConversationRecorder {
    return new ConversationRecorder(this, meta, log ?? this.log);
  }
}
