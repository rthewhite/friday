/**
 * The brain's tools: remember and recall pages, and recall earlier conversations. There is deliberately no tool
 * that deletes or rewrites memories.
 */
import {
  localDate,
  SearchQueryError,
  startOfLocalDay,
  Type,
  type ConversationChannel,
  type ConversationMatch,
  type ModuleContext,
  type ModuleConversations,
  type SnippetEntry,
} from "@friday/sdk";
import { nameKey } from "./links.js";
import { search, searchTerms } from "./search.js";
import { PAGE_TYPES, type BrainStore, type Page, type PageType } from "./store.js";

/** Other pages `brain_recall` returns after an exact name match. */
export const RECALL_HITS = 3;
/** Connections (links and backlinks) returned with a recall. */
export const RECALL_CONNECTIONS = 10;
/** Page names listed when nothing matches. */
export const RECALL_NAMES = 50;

export interface Connection {
  from: string;
  to: string;
  line: string;
  exists: boolean;
}

export function defineBrainTools(ctx: ModuleContext, store: BrainStore, today: () => string, zone: () => string): void {
  ctx.defineTool<{ entity: string; fact: string; type?: PageType }>({
    name: "brain_remember",
    description:
      "Store one lasting fact in Friday's long-term memory, as a dated note on a page. Use the name of a person, " +
      "place or project as entity (reuse a name or alias from the memory index when one fits), or \"profile\" for facts " +
      "about the user or the household. Friday can't tell voices apart: facts about the speaker go on the profile unless " +
      "they say who they are. One fact per call; write it so it reads on its own. [[Name]] may reference other pages. " +
      "Existing notes are never changed; a correction is stored as a new, newer note.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        entity: { type: Type.STRING, description: "Page name or alias, or \"profile\"" },
        fact: { type: Type.STRING, description: "The fact, one short sentence" },
        type: { type: Type.STRING, enum: [...PAGE_TYPES], description: "Kind of page, used when the page is new (default other)" },
      },
      required: ["entity", "fact"],
    },
    handler: ({ entity, fact, type }) => store.appendNote(entity, fact, type, today()),
  });

  ctx.defineTool<{ query: string; entity?: string }>({
    name: "brain_recall",
    description:
      "Look up Friday's long-term memory. Pass what you want to know as query, and the page name when you know it as entity. " +
      "Returns the matching pages in full with their links. Call it before answering about anything listed in the memory index, " +
      "or when the user refers to something that may have been noted before. Notes are dated; the newer of two contradicting notes holds.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "What to look for, in a few words" },
        entity: { type: Type.STRING, description: "Name of the person, place or project, when known" },
      },
      required: ["query"],
    },
    handler: ({ query, entity }) => recall(store, query, entity),
  });

  ctx.defineTool<RecallConversationsArgs>({
    name: "brain_recall_conversations",
    description:
      "Search what was said in earlier conversations with Friday (voice and chat): use it for \"what did we talk about…\", " +
      "\"what did I ask you…\", \"what did we watch…\". For what Friday knows about people, places and projects use brain_recall. " +
      "Pass a few words as query, and dates as since/until (YYYY-MM-DD, whole days in the household's time zone, both inclusive); " +
      "call get_current_time first to turn \"yesterday\" or \"last week\" into dates. Without a query it returns the conversations " +
      "in those days, or the most recent ones. The current conversation is never included. Speech was transcribed, so try " +
      "other words when a name isn't found.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Words to look for, e.g. \"film\" or \"boiler service\"" },
        since: { type: Type.STRING, description: "First day to search, YYYY-MM-DD" },
        until: { type: Type.STRING, description: "Last day to search, YYYY-MM-DD" },
        channel: { type: Type.STRING, enum: ["voice", "chat"], description: "Only voice or only chat conversations" },
      },
    },
    handler: (args, call) => recallConversations(ctx.conversations, args, zone(), call.conversationId),
  });
}

export interface RecallConversationsArgs {
  query?: string;
  since?: string;
  until?: string;
  channel?: ConversationChannel;
}

/** Conversations `brain_recall_conversations` returns at most. */
export const RECALL_CONVERSATIONS = 5;
/** The tool's result is cut to this many characters of JSON, dropping the lowest-ranked conversations. */
export const RECALL_CONVERSATIONS_CHARS = 8000;

type RecalledEntry = { who: "user" | "friday"; text: string; interrupted?: true } | { who: "tool"; tool: string; args: unknown };

/** The day after a `YYYY-MM-DD` date, as `YYYY-MM-DD`. */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:mm` of an instant in `zone`. */
function localDateTime(at: string, zone: string): string {
  const d = new Date(at);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${localDate(d, zone)} ${time}`;
}

function recalled(e: SnippetEntry): RecalledEntry {
  if (e.kind === "tool") return { who: "tool", tool: e.name, args: e.args };
  if (e.kind === "assistant") return e.interrupted ? { who: "friday", text: e.text, interrupted: true } : { who: "friday", text: e.text };
  return { who: "user", text: e.text };
}

/**
 * Design D6: dates as whole local days (until inclusive), brain_recall's word rules, the caller's own conversation
 * excluded, at most 5 conversations cut to 8000 characters of JSON from the lowest-ranked end. Refused input,
 * including a query with no searchable words, is an `{ error }` result the model can act on.
 */
export async function recallConversations(
  conversations: Pick<ModuleConversations, "search">,
  { query, since, until, channel }: RecallConversationsArgs,
  zone: string,
  current?: string,
): Promise<Record<string, unknown>> {
  const bounds: { since?: string; until?: string } = {};
  for (const [name, value] of [["since", since], ["until", until]] as const) {
    if (value === undefined || value === "") continue;
    // until is inclusive: the window ends where the next day starts (which must be a date too: not after 9999).
    const start = typeof value === "string" ? startOfLocalDay(value, zone) : undefined;
    const bound = start && name === "until" ? startOfLocalDay(nextDay(value), zone) : start;
    if (!bound) return { error: `${name} must be a date as YYYY-MM-DD, got ${JSON.stringify(value)}` };
    bounds[name] = bound.toISOString();
  }
  if (since && until && since > until) return { error: `since (${since}) is after until (${until})` };
  const words = searchTerms(query);
  // A query whose every word is dropped would otherwise search nothing and read as "the latest conversations".
  if (query?.trim() && !words.length) {
    return { error: `query ${JSON.stringify(query)} has no searchable words: use words of 3 or more letters that aren't filler words, e.g. "television" rather than "TV"` };
  }

  let matches: ConversationMatch[];
  try {
    matches = await conversations.search({
      query: words.join(" "),
      ...bounds,
      channel,
      exclude: current ? [current] : [],
      limit: RECALL_CONVERSATIONS,
    });
  } catch (e) {
    if (e instanceof SearchQueryError) return { error: e.message };
    throw e;
  }

  const found = matches.map((m) => ({
    id: m.id,
    channel: m.channel,
    ...(m.device ? { device: m.device } : {}),
    started: localDateTime(m.startedAt, zone),
    snippets: m.snippets.map((s) => s.map(recalled)),
  }));
  if (!found.length) {
    const days = since || until ? ` between ${since || "the start"} and ${until || "today"}` : "";
    return { found: 0, message: `No earlier conversations matched${days}.` };
  }
  const size = () => JSON.stringify({ found: found.length, conversations: found }).length;
  // Drop the lowest-ranked conversations first; the best match is always kept, down to its first snippet
  // (at most 3 entries of 300 characters, so it fits).
  while (found.length > 1 && size() > RECALL_CONVERSATIONS_CHARS) found.pop();
  while (found[0].snippets.length > 1 && size() > RECALL_CONVERSATIONS_CHARS) found[0].snippets.pop();
  return { found: found.length, conversations: found };
}

type RecalledPage = Pick<Page, "name" | "type" | "aliases" | "body" | "updatedAt"> & { found_by: "name" | "search" | "name+search" };

/** Design D4: the exact entity first, then the best other hits, with up to 10 connections. */
export function recall(store: BrainStore, query: string, entity?: string): Record<string, unknown> {
  const exact = entity ? store.resolve(entity) : undefined;
  const named = exact && !exact.isProfile ? exact : undefined;
  const hits = search(store.list(), searchTerms(query, entity));
  const pages: { page: Page; found_by: RecalledPage["found_by"] }[] = [];
  if (named) pages.push({ page: named, found_by: hits.some((h) => h.page.id === named.id) ? "name+search" : "name" });
  for (const h of hits) {
    if (pages.length >= (named ? 1 : 0) + RECALL_HITS) break;
    if (h.page.id !== named?.id) pages.push({ page: h.page, found_by: "search" });
  }
  if (!pages.length) {
    return {
      found: false,
      message: "Nothing in memory matches. These pages exist; retry with one of their names if it fits.",
      pages: store.recent(RECALL_NAMES).map((p) => p.name),
    };
  }
  return {
    found: true,
    pages: pages.map(({ page, found_by }): RecalledPage => ({ name: page.name, type: page.type, aliases: page.aliases, body: page.body, updatedAt: page.updatedAt, found_by })),
    connections: connections(store, pages.map((p) => p.page)),
  };
}

function connections(store: BrainStore, pages: Page[]): Connection[] {
  const out: Connection[] = [];
  const seen = new Set<string>();
  const add = (c: Connection) => {
    const key = `${nameKey(c.from)}>${nameKey(c.to)}>${c.line}`;
    if (seen.has(key) || out.length >= RECALL_CONNECTIONS) return;
    seen.add(key);
    out.push(c);
  };
  for (const p of pages) for (const l of store.links(p)) add({ from: p.name, to: l.pageName ?? l.target, line: l.line, exists: l.pageId !== undefined });
  for (const p of pages) for (const b of store.backlinks(p)) add({ from: b.name, to: p.name, line: b.line, exists: true });
  return out;
}
