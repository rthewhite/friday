/** The brain's two tools. There is deliberately no tool that deletes or rewrites memories. */
import { Type, type ModuleContext } from "@friday/sdk";
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

export function defineBrainTools(ctx: ModuleContext, store: BrainStore, today: () => string): void {
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
