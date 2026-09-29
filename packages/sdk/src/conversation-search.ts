/**
 * Conversation search rules shared by core's store and the test host's in-memory conversations:
 * which words count, which inputs are refused, how matches rank and how snippets are cut. Stores
 * only decide which entries hold which words (core with its full-text index, the test host by
 * substring), then hand those hits to `compareMatches` and `snippetsFor`.
 */
import type { ConversationChannel, ConversationEntry, ConversationInput, ConversationSummary } from "./conversations.js";
import { CHANNELS } from "./tool.js";

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
/** Snippets per matched conversation. */
export const MAX_SNIPPETS = 3;
/** Snippet text, and tool arguments as JSON, are cut at this many characters. */
export const SNIPPET_CHARS = 300;
/** Shorter words can't match (the index works on three-character sequences), so they are dropped. */
export const MIN_WORD_LENGTH = 3;

export interface SearchConversationsOptions {
  /** Words to look for; any part of a word matches, without case and accents. */
  query?: string;
  /** Only entries at or after this ISO 8601 instant. */
  since?: string;
  /** Only entries before this ISO 8601 instant. */
  until?: string;
  channel?: ConversationChannel;
  device?: string;
  /** Conversation ids never returned, such as the one the caller is in. */
  exclude?: string[];
  /** Default 5, at most 20. */
  limit?: number;
}

/** A snippet entry: a turn cut to 300 characters, or a tool call without its result. */
export type SnippetEntry =
  | { seq: number; at: string; kind: "user"; input: ConversationInput; text: string }
  | { seq: number; at: string; kind: "assistant"; text: string; interrupted: boolean }
  /** `args` is the JSON value, or its JSON text cut to 300 characters when longer. */
  | { seq: number; at: string; kind: "tool"; name: string; args: unknown };

export interface ConversationMatch extends ConversationSummary {
  /** Up to 3 runs of consecutive entries, earliest first. */
  snippets: SnippetEntry[][];
}

/** Refused search input; the message says what is wrong. */
export class SearchQueryError extends Error {}

/** A search with its input checked: folded words, instants normalised to ISO, limit clamped. */
export interface ValidSearch {
  words: string[];
  since?: string;
  until?: string;
  channel?: ConversationChannel;
  device?: string;
  exclude: string[];
  limit: number;
}

/** Lower-cased with accents stripped, as search compares text. */
export function foldSearchText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The distinct folded words of `query` that can match: 3 characters or more, in order. */
export function queryWords(query: string | undefined): string[] {
  const out: string[] = [];
  for (const word of foldSearchText(query ?? "").split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= MIN_WORD_LENGTH && !out.includes(word)) out.push(word);
  }
  return out;
}

function instant(v: string | undefined, what: string): string | undefined {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (typeof v !== "string" || Number.isNaN(d.getTime())) throw new SearchQueryError(`invalid ${what}: ${String(v)}`);
  return d.toISOString();
}

/** Check and normalise search input; throws `SearchQueryError`. */
export function validateSearch(opts: SearchConversationsOptions = {}): ValidSearch {
  if (opts.channel !== undefined && !CHANNELS.includes(opts.channel)) throw new SearchQueryError(`invalid channel: ${String(opts.channel)}`);
  const since = instant(opts.since, "since");
  const until = instant(opts.until, "until");
  if (since && until && since > until) throw new SearchQueryError("since is after until");
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit ?? DEFAULT_SEARCH_LIMIT)) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const out: ValidSearch = { words: queryWords(opts.query), exclude: [...(opts.exclude ?? [])], limit };
  if (since) out.since = since;
  if (until) out.until = until;
  if (opts.channel) out.channel = opts.channel;
  if (opts.device !== undefined) out.device = opts.device;
  return out;
}

/** Whether an entry time falls in the search's `[since, until)` window. */
export function inWindow(at: string, s: Pick<ValidSearch, "since" | "until">): boolean {
  const t = Date.parse(at);
  return (!s.since || t >= Date.parse(s.since)) && (!s.until || t < Date.parse(s.until));
}

/** The string and number values in a JSON value, depth first, without its keys. */
function values(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(values);
  if (v && typeof v === "object") return Object.values(v).flatMap(values);
  return [];
}

/**
 * What the index holds for an entry: its text, or a tool's name and the values in its arguments (not their keys,
 * never the result). Arguments cut short are no longer JSON, so their text goes in as it is.
 */
export function searchableText(e: ConversationEntry): string {
  if (e.kind !== "tool") return e.text;
  return [e.name, ...values(e.args)].join(" ");
}

/** A candidate for ranking: how many distinct words it matched, and its recency. */
export interface RankedCandidate {
  id: string;
  lastActivityAt: string;
  words: number;
}

/** Most distinct words first, then most recent activity, then id (descending) for a stable order. */
export function compareMatches(a: RankedCandidate, b: RankedCandidate): number {
  return b.words - a.words || (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

const cut = (text: string): string => (text.length > SNIPPET_CHARS ? text.slice(0, SNIPPET_CHARS) : text);

function snippetEntry(e: ConversationEntry): SnippetEntry {
  if (e.kind === "user") return { seq: e.seq, at: e.at, kind: "user", input: e.input, text: cut(e.text) };
  if (e.kind === "assistant") return { seq: e.seq, at: e.at, kind: "assistant", text: cut(e.text), interrupted: e.interrupted };
  const json = typeof e.args === "string" && e.truncated ? e.args : (JSON.stringify(e.args) ?? "null");
  return { seq: e.seq, at: e.at, kind: "tool", name: e.name, args: json.length > SNIPPET_CHARS ? json.slice(0, SNIPPET_CHARS) : e.args };
}

/**
 * Snippets from a conversation's in-window entries (in order). With `matching` seqs: each matching
 * entry with the entry before and after it, skipping a match an earlier snippet already shows, at
 * most 3. Without: the first 3 entries.
 */
export function snippetsFor(entries: ConversationEntry[], matching?: ReadonlySet<number>): SnippetEntry[][] {
  if (!matching) return entries.length ? [entries.slice(0, MAX_SNIPPETS).map(snippetEntry)] : [];
  const out: SnippetEntry[][] = [];
  const shown = new Set<number>();
  for (let i = 0; i < entries.length && out.length < MAX_SNIPPETS; i++) {
    const e = entries[i];
    if (!matching.has(e.seq) || shown.has(e.seq)) continue;
    const run = entries.slice(Math.max(i - 1, 0), i + 2);
    for (const r of run) shown.add(r.seq);
    out.push(run.map(snippetEntry));
  }
  return out;
}
