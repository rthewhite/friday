/**
 * The profile summary (hybrid-profile D5): after consolidation, one model call writes the summary from the
 * pages. It is checked before it is written: within the budget, every link to a live page, and every line
 * backed by the user's page or the pages it names, so it can leave things out but never invent them.
 * A refused summary gets one repair round; otherwise the old one stays.
 */
import { LlmError, type LlmMessage, type ModuleLlm, type ModuleLogger, type ModuleStorage } from "@friday/sdk";
import { indexLine } from "../context.js";
import { significantWords } from "../search.js";
import { BrainError, type BrainStore, type Page } from "../store.js";
import { estimateTokens } from "../text.js";
import { content, namedPagesFinder, preserved } from "./consolidate.js";
import { GUIDANCE_VERSION, summarySystem } from "./guidance.js";
import { BRAIN_MAX } from "./render.js";

/** The newest revision id the last generated summary took into account. */
const WATERMARK = "summary:last_revision_id";
/** The GUIDANCE_VERSION the last summary was generated under. */
const GUIDANCE = "summary:guidance";

export const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string", description: "The profile summary, as markdown lines" } },
  required: ["summary"],
};

export interface SummaryDeps {
  store: BrainStore;
  llm: ModuleLlm;
  storage: ModuleStorage;
  log: ModuleLogger;
  /** BRAIN_PROFILE_TOKEN_BUDGET. */
  budget: () => number;
}

export interface SummaryOutcome {
  /** False when no page and no guidance changed since the last summary (no model call). */
  ran: boolean;
  /** A new summary was written. */
  generated: boolean;
  /** Set when no summary was written (refused twice, model unavailable, cancelled): the run is `partial`. */
  failed?: string;
}

function pageBlock(p: Page, subject: boolean): string {
  const meta = [p.type, ...(subject ? ["the user's own page"] : []), ...(p.aliases.length ? [`aka ${p.aliases.join(", ")}`] : [])].join("; ");
  return `### ${p.name} (${meta})\n${p.body.trim() || "(empty)"}`;
}

/**
 * The summary's input: the budget, the user's page and the household's home page in full, then the user's
 * link neighbours and the most recently updated pages in full up to `max`, an index of the rest, and the
 * current summary.
 */
export function summaryInput(store: BrainStore, budget: number, max = BRAIN_MAX): string {
  const subject = store.subject();
  const home = store.resolve("Home");
  const pages = store.list().filter((p) => !p.isProfile);
  const neighbours = new Set([...store.links(subject).flatMap((l) => (l.pageId ? [l.pageId] : [])), ...store.backlinks(subject).map((b) => b.pageId)]);
  const rank = (p: Page) => (p.id === subject.id ? 0 : p.id === home?.id ? 1 : neighbours.has(p.id) ? 2 : 3);
  const ordered = [...pages].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  const current = store.profile().body.trim();
  const header = `Profile budget: at most ${budget} tokens (estimated as characters / 4).`;
  const tail = `## The current summary\n${current || "(none yet)"}`;
  const blocks: string[] = [];
  const index: string[] = [];
  let size = header.length + tail.length + 100;
  for (const p of ordered) {
    const b = pageBlock(p, p.id === subject.id);
    if (!index.length && (size + b.length + 2 <= max || rank(p) <= 1)) {
      blocks.push(b);
      size += b.length + 2;
    } else index.push(indexLine(p));
  }
  return [header, "## Pages", ...blocks, ...(index.length ? [`## Other pages (index only)\n${index.join("\n")}`] : []), tail].join("\n\n");
}

/** Everything wrong with a summary, as reasons for the model; empty when it may be written. */
export function validateSummary(store: BrainStore, text: unknown, budget: number): string[] {
  if (typeof text !== "string") return ["the answer has no summary text"];
  const reasons: string[] = [];
  const tokens = estimateTokens(text.trim());
  if (tokens > budget) reasons.push(`the summary is about ${tokens} tokens; it must be at most ${budget}`);
  for (const l of store.links({ body: text })) {
    if (!l.pageId || store.get(l.pageId)?.isProfile) reasons.push(`[[${l.target}]] is not a page; link only to pages that exist`);
  }
  // A line is backed when most of its words, other than the names of the pages it names, are on the user's page or those pages.
  const subject = store.subject();
  const named = namedPagesFinder(store);
  for (const line of text.split("\n")) {
    const c = content(line);
    if (!c || /^#{1,6}(\s|$)/.test(line.trim())) continue;
    const pages = named(c).filter((p) => !p.isProfile);
    const own = new Set(significantWords(pages.flatMap((p) => [p.name, ...p.aliases]).join("\n")));
    const rest = significantWords(c.replace(/\[\[([^[\]\n]+)\]\]/g, "$1")).filter((w) => !own.has(w));
    if (!rest.length) continue;
    const source = [subject, ...pages].map((p) => p.body).join("\n");
    if (!preserved(rest.join(" "), source)) reasons.push(`the line "${line.trim()}" is not stated on ${subject.name} or the pages it names`);
  }
  return reasons;
}

/** The summary step: skipped when nothing changed; otherwise generate, validate, write, repair once. */
export async function runSummary(deps: SummaryDeps, signal: AbortSignal): Promise<SummaryOutcome> {
  const { store } = deps;
  const since = (await deps.storage.get<number>(WATERMARK)) ?? 0;
  const seenUpTo = store.lastRevisionId();
  const profileId = store.profile().id;
  // Any write counts, the nightly pass's own included: the summary follows the pages.
  const changed = [...store.changesSince(since, []).keys()].filter((id) => id !== profileId);
  const guidanceChanged = ((await deps.storage.get<number>(GUIDANCE)) ?? 0) < GUIDANCE_VERSION;
  if (!changed.length && !guidanceChanged) return { ran: false, generated: false };
  const done = async () => {
    await deps.storage.set(WATERMARK, seenUpTo);
    await deps.storage.set(GUIDANCE, GUIDANCE_VERSION);
  };

  // An empty brain has an empty summary, without a model call.
  if (store.count() === 1 && !store.subject().body.trim()) {
    const generated = store.profile().body !== "";
    if (generated) store.writeSummary("", "consolidation", { note: "summary of an empty brain" });
    await done();
    return { ran: true, generated };
  }

  const budget = deps.budget();
  const prompt = `${summaryInput(store, budget)}\n\nWrite the summary.`;
  const request = { system: summarySystem(store.subject().name), schema: SUMMARY_SCHEMA, model: "standard" as const, temperature: 0.2, maxOutputTokens: 8192, timeoutMs: 120_000, signal };

  const attempt = async (messages: LlmMessage[]): Promise<{ text?: string; raw: string; reasons: string[]; written?: boolean; fatal?: string }> => {
    let raw = "";
    let text: string | undefined;
    try {
      const r = await deps.llm.generate<{ summary: string }>({ ...request, messages });
      raw = r.text;
      text = r.json?.summary;
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      if (e.kind === "invalid_output" || e.kind === "blocked") return { raw: e.raw ?? "", reasons: [`the answer was not a valid summary (${e.kind}: ${e.message})`] };
      return { raw, reasons: [], fatal: e.kind === "cancelled" ? "cancelled" : `model ${e.kind}: ${e.message}` };
    }
    const reasons = validateSummary(store, text, budget);
    if (reasons.length) return { text, raw, reasons };
    try {
      store.writeSummary(text!.trim(), "consolidation", { note: "generated from the pages" });
      return { text, raw, reasons: [], written: true };
    } catch (e) {
      if (!(e instanceof BrainError)) throw e;
      return { text, raw, reasons: [`writing the summary failed: ${e.message}`] };
    }
  };

  const first = await attempt([{ role: "user", text: prompt }]);
  let result = first;
  if (!first.written && !first.fatal) {
    deps.log.log(`nightly: summary refused (${first.reasons.length} reasons); asking for a repair`);
    result = await attempt([
      { role: "user", text: prompt },
      { role: "model", text: first.raw || JSON.stringify({ summary: first.text ?? "" }) },
      { role: "user", text: `The summary was refused, and nothing was changed:\n${first.reasons.map((r) => `- ${r}`).join("\n")}\n\nWrite it again, fixing these.` },
    ]);
  }
  if (!result.written) {
    const failed = result.fatal ?? `summary refused twice: ${result.reasons.join("; ")}`;
    deps.log.warn(`nightly: ${failed}`);
    return { ran: true, generated: false, failed };
  }
  await done();
  return { ran: true, generated: true };
}
