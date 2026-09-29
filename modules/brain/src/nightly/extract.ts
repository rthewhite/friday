/**
 * Nightly extraction (design D2, D3): lasting facts from finished conversations become notes, appended
 * exactly like `brain_remember` (author `extraction`, the conversation as source). Never rewrites text.
 */
import { LlmError, type Conversation, type ModuleConversations, type ModuleLlm, type ModuleLogger, type ModuleStorage } from "@friday/sdk";
import type { BrainStore, PageType } from "../store.js";
import { PAGE_TYPES } from "../types.js";
import { extractionSystem } from "./guidance.js";
import type { ExtractOutcome } from "./job.js";
import { conversationDate, renderBrain, renderTranscript, userWords } from "./render.js";

/** Conversations whose new entries carry fewer user words than this are skipped without a model call. */
export const TRIVIAL_WORDS = 4;
/** Invalid or blocked answers for one conversation before it is given up. */
export const MAX_ATTEMPTS = 3;
export const MAX_NOTES = 10;

export const NOTES_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      maxItems: MAX_NOTES,
      items: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Page name or alias, or \"profile\"" },
          fact: { type: "string", description: "One lasting fact, readable on its own" },
          type: { type: "string", enum: [...PAGE_TYPES], description: "Kind of page, for a new page" },
          reason: { type: "string", description: "Why this is a lasting fact (not stored)" },
        },
        required: ["entity", "fact", "reason"],
      },
    },
  },
  required: ["notes"],
};

export interface ExtractedNote {
  entity: string;
  fact: string;
  type?: PageType;
  reason: string;
}

export interface ExtractDeps {
  store: BrainStore;
  conversations: ModuleConversations;
  llm: ModuleLlm;
  storage: ModuleStorage;
  log: ModuleLogger;
  /** BRAIN_NIGHTLY_MAX_CONVERSATIONS, read at each run. */
  maxConversations: () => number;
  /** FRIDAY_TIMEZONE, read at each run. */
  zone: () => string | undefined;
}

const WATERMARK = "extract:watermark";
const seenKey = (id: string) => `extract:seen:${id}`;
const retryKey = (id: string) => `extract:retry:${id}`;
const EPOCH = new Date(0).toISOString();

interface Retry {
  attempts: number;
  lastError: string;
}

/** Asks the model for one conversation's notes and appends them. Throws `LlmError` on a model failure. */
export async function extractConversation(deps: ExtractDeps, c: Conversation, seenSeq: number, signal: AbortSignal): Promise<{ notes: number; refused: number }> {
  const fresh = c.entries.filter((e) => e.seq > seenSeq);
  const userText = fresh.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text).join("\n");
  const r = await deps.llm.generate<{ notes: ExtractedNote[] }>({
    system: extractionSystem(renderBrain(deps.store, userText)),
    prompt: `${renderTranscript(c, seenSeq, deps.zone())}\n\nList the notes (usually none).`,
    schema: NOTES_SCHEMA,
    model: "standard",
    temperature: 0.2,
    maxOutputTokens: 4096,
    timeoutMs: 120_000,
    signal,
  });
  const date = conversationDate(c, deps.zone(), (m) => deps.log.warn(m));
  let notes = 0;
  let refused = 0;
  for (const n of (r.json?.notes ?? []).slice(0, MAX_NOTES)) {
    const res = deps.store.appendNote(n.entity, n.fact, n.type, date, { author: "extraction", sources: [c.id] });
    if (res.stored) notes++;
    else if (res.reason !== "already_known") {
      refused++;
      deps.log.log(`nightly: note for ${JSON.stringify(n.entity)} refused (${res.reason}): ${res.message}`);
    }
  }
  return { notes, refused };
}

/** Extraction for one run: retries first, then conversations quiet since the watermark (design D2). */
export async function runExtract(deps: ExtractDeps, signal: AbortSignal): Promise<ExtractOutcome> {
  const out: ExtractOutcome = { conversations: 0, skipped: 0, notes: 0, refused: 0, errors: [] };
  const max = Math.max(1, deps.maxConversations());

  // 1. Conversations that failed on earlier runs, oldest first.
  const retries: { c: Conversation; retry: Retry }[] = [];
  for (const key of await deps.storage.list("extract:retry:")) {
    const id = key.slice("extract:retry:".length);
    const c = await deps.conversations.get(id);
    if (!c) {
      await forget(deps, id);
      continue;
    }
    if (c.state === "quiet") retries.push({ c, retry: (await deps.storage.get<Retry>(key)) ?? { attempts: 0, lastError: "" } });
  }
  retries.sort((a, b) => (a.c.quietAt ?? "").localeCompare(b.c.quietAt ?? ""));
  const queue: { id: string; quietAt?: string; listed: boolean }[] = retries.slice(0, max).map((r) => ({ id: r.c.id, listed: false }));

  // 2. Conversations that went quiet since the watermark, in list order. The watermark is a cursor
  // (quietAt plus the ids already handled at exactly that time): several conversations can go quiet in
  // the same millisecond, and a bare timestamp with core's strict `>` would lose the ones after a cut.
  const room = max - queue.length;
  let cursor = await readWatermark(deps.storage);
  if (room > 0) {
    const since = cursor ? new Date(Date.parse(cursor.quietAt) - 1).toISOString() : EPOCH;
    const listed = await deps.conversations.list({ quietSince: since, limit: room + (cursor?.ids.length ?? 0) });
    const fresh = listed.filter((s) => !(cursor && s.quietAt === cursor.quietAt && cursor.ids.includes(s.id)));
    // A listed conversation that is also a retry keeps its list position, so the watermark never
    // moves past a conversation that wasn't handled yet.
    for (const s of fresh.slice(0, room)) queue.push({ id: s.id, quietAt: s.quietAt!, listed: true });
  }

  // 3. Handle each; a stop (model unavailable, cancelled) leaves the current conversation for next time.
  const handled = new Set<string>();
  for (const q of queue) {
    if (signal.aborted) {
      out.stopped = "cancelled";
      break;
    }
    if (!handled.has(q.id)) {
      const status = await handle(deps, q.id, signal, out);
      if (status === "stop") break;
      handled.add(q.id);
    }
    if (q.listed && q.quietAt) {
      cursor = cursor && cursor.quietAt === q.quietAt ? { quietAt: q.quietAt, ids: [...cursor.ids, q.id] } : { quietAt: q.quietAt, ids: [q.id] };
      await deps.storage.set(WATERMARK, cursor);
    }
  }

  await prune(deps);
  return out;
}

async function handle(deps: ExtractDeps, id: string, signal: AbortSignal, out: ExtractOutcome): Promise<"done" | "stop"> {
  const c = await deps.conversations.get(id);
  if (!c) {
    await forget(deps, id);
    return "done";
  }
  const seen = (await deps.storage.get<{ seq: number }>(seenKey(id)))?.seq ?? 0;
  const fresh = c.entries.filter((e) => e.seq > seen);
  if (!fresh.length) return "done";
  const last = fresh[fresh.length - 1]!.seq;
  if (userWords(fresh) < TRIVIAL_WORDS) {
    out.conversations++;
    out.skipped++;
    await markSeen(deps, id, last);
    return "done";
  }
  try {
    const r = await extractConversation(deps, c, seen, signal);
    out.conversations++;
    out.notes += r.notes;
    out.refused += r.refused;
    await markSeen(deps, id, last);
    return "done";
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    if (e.kind === "unavailable" || e.kind === "cancelled") {
      out.stopped = e.kind === "cancelled" ? "cancelled" : `model unavailable: ${e.message}`;
      return "stop";
    }
    // invalid_output, blocked, invalid_request: retried on the next runs, given up after 3 attempts.
    const retry = (await deps.storage.get<Retry>(retryKey(id))) ?? { attempts: 0, lastError: "" };
    const attempts = retry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      deps.log.warn(`nightly: giving up on conversation ${id} after ${attempts} attempts: ${e.kind}: ${e.message}`);
      out.errors.push(`gave up on conversation ${id} (${e.kind})`);
      await markSeen(deps, id, last);
    } else {
      await deps.storage.set(retryKey(id), { attempts, lastError: `${e.kind}: ${e.message}` });
    }
    return "done";
  }
}

interface Watermark {
  quietAt: string;
  /** Conversations with exactly this quietAt that were already handled. */
  ids: string[];
}

async function readWatermark(storage: ModuleStorage): Promise<Watermark | undefined> {
  const w = await storage.get<Watermark | string>(WATERMARK);
  if (typeof w === "string") return { quietAt: w, ids: [] };
  return w && typeof w.quietAt === "string" && Array.isArray(w.ids) ? w : undefined;
}

async function markSeen(deps: ExtractDeps, id: string, seq: number): Promise<void> {
  await deps.storage.set(seenKey(id), { seq });
  await deps.storage.delete(retryKey(id));
}

async function forget(deps: ExtractDeps, id: string): Promise<void> {
  await deps.storage.delete(seenKey(id));
  await deps.storage.delete(retryKey(id));
}

/** Drops progress kept for conversations that no longer exist (retention, deleted by the user). */
async function prune(deps: ExtractDeps): Promise<void> {
  for (const key of await deps.storage.list("extract:seen:")) {
    const id = key.slice("extract:seen:".length);
    if (!(await deps.conversations.get(id))) await forget(deps, id);
  }
}
