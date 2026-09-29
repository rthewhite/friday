/**
 * What the nightly pass shows the model (design D3): the transcript with `[earlier]` / `[new]` entries and
 * no tool results, and the brain, bounded at 60000 characters with the most relevant pages in full.
 */
import type { Conversation, ConversationEntry } from "@friday/sdk";
import { indexLine } from "../context.js";
import { fold, significantWords } from "../search.js";
import type { BrainStore, Page } from "../store.js";
import { safeLocalDate } from "../time.js";

/** Largest rendering of the brain sent to the model. */
export const BRAIN_MAX = 60000;
/** Tool arguments longer than this are cut in the transcript. */
const ARGS_MAX = 300;

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

/** Number of words the user said or typed in `entries`. */
export function userWords(entries: ConversationEntry[]): number {
  return entries.reduce((n, e) => (e.kind === "user" ? n + e.text.split(/\s+/).filter(Boolean).length : n), 0);
}

/** The day a conversation's notes are dated with: its last activity, in the household's zone. */
export function conversationDate(c: Pick<Conversation, "lastActivityAt">, zone: string | undefined, warn: (m: string) => void = () => {}): string {
  return safeLocalDate(new Date(c.lastActivityAt), zone, warn);
}

function entryLine(e: ConversationEntry): string {
  if (e.kind === "user") return `user (${e.input === "speech" ? "spoken, transcribed" : "typed"}): ${e.text}`;
  if (e.kind === "assistant") return `friday${e.interrupted ? " (interrupted)" : ""}: ${e.text}`;
  // Tool results are data fetched from elsewhere and may try to steer the model: never shown.
  if (e.name === "brain_remember") {
    const a = (e.args ?? {}) as { entity?: unknown; fact?: unknown };
    return `(already remembered: ${String(a.entity ?? "")}: ${String(a.fact ?? "")})`;
  }
  let args = typeof e.args === "string" ? e.args : JSON.stringify(e.args ?? {});
  if (args.length > ARGS_MAX) args = `${args.slice(0, ARGS_MAX - 1)}…`;
  return `tool ${e.name}(${args})`;
}

/** The transcript: a header, then entries up to `seenSeq` as `[earlier]` and the rest as `[new]`. */
export function renderTranscript(c: Conversation, seenSeq: number, zone: string | undefined): string {
  const date = conversationDate(c, zone);
  const header = `Conversation on ${WEEKDAY.format(new Date(`${date}T12:00:00Z`))} ${date}, channel ${c.channel}${c.device ? `, device "${c.device}" (a device, not a person)` : ""}.`;
  const earlier = c.entries.filter((e) => e.seq <= seenSeq).map(entryLine);
  const fresh = c.entries.filter((e) => e.seq > seenSeq).map(entryLine);
  return [header, ...(earlier.length ? ["", "[earlier] (context only; already processed)", ...earlier] : []), "", "[new]", ...fresh].join("\n");
}

function pageBlock(p: Page): string {
  const meta = [p.isProfile ? "the user and the household" : p.type, ...(p.aliases.length ? [`aka ${p.aliases.join(", ")}`] : [])].join("; ");
  return `### ${p.name} (${meta})\n${p.body.trim() || "(empty)"}`;
}

/**
 * The brain for extraction: the profile and live pages in full, dangling link targets, and tombstoned
 * names. Beyond `max` characters, pages are ranked by how many significant words of `relevantTo` they
 * contain; the best ones stay in full and the rest become index lines.
 */
export function renderBrain(store: BrainStore, relevantTo: string, max = BRAIN_MAX): string {
  const all = store.list();
  const profile = all.find((p) => p.isProfile)!;
  const pages = all.filter((p) => !p.isProfile);
  const dangling = store.danglingTargets();
  const forgotten = store.tombstones().map((t) => t.name);
  const tail = [
    `## Links to pages that don't exist yet\n${dangling.length ? dangling.map((d) => `- ${d}`).join("\n") : "(none)"}`,
    `## Deliberately forgotten: never record these\n${forgotten.length ? forgotten.map((d) => `- ${d}`).join("\n") : "(none)"}`,
  ].join("\n\n");
  const full = [pageBlock(profile), ...pages.map(pageBlock)].join("\n\n");
  if (full.length + tail.length + 2 <= max) return `${full}\n\n${tail}`;

  const words = significantWords(relevantTo);
  const relevance = (p: Page) => {
    const text = fold(`${p.name}\n${p.aliases.join("\n")}\n${p.body}`);
    return words.filter((w) => text.includes(w)).length;
  };
  const ranked = pages.map((p) => ({ p, r: relevance(p) })).sort((a, b) => b.r - a.r || b.p.updatedAt.localeCompare(a.p.updatedAt)).map((x) => x.p);
  const blocks = [pageBlock(profile)];
  const index: string[] = [];
  let used = blocks[0]!.length + tail.length + 200;
  for (const p of ranked) {
    const b = pageBlock(p);
    if (!index.length && used + b.length + 2 <= max) {
      blocks.push(b);
      used += b.length + 2;
    } else {
      index.push(indexLine(p));
    }
  }
  // The index is cut too when even the name list doesn't fit.
  let indexText = index.join("\n");
  const room = max - used - 40;
  if (indexText.length > room) indexText = `${indexText.slice(0, Math.max(0, indexText.lastIndexOf("\n", room)))}\n- …more pages not shown`;
  return [...blocks, ...(index.length ? [`### Other pages (index only)\n${indexText}`] : []), tail].join("\n\n");
}
